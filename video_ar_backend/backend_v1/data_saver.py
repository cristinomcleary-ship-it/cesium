"""
兼容保留的数据保存模块。

当前服务入口不实例化该类；正式航次由 main.py 原子保存。
"""
import os
import json
import time
import logging
import asyncio
from datetime import datetime
from typing import Optional, Dict, Any
import cv2
import numpy as np
from .models import DroneStatus, VideoFrame, DroneCoordinates, GimbalAttitude

logger = logging.getLogger(__name__)

class DataSaver:
    """数据保存器 - 负责保存视频流和坐标数据"""
    
    def __init__(self, save_interval: int = 120):  # 默认2分钟
        self.save_interval = save_interval  # 保存间隔（秒）
        self.video_dir = "video"
        self.is_saving = False
        self.save_task = None
        
        # 当前数据缓存
        self.current_coordinates: Optional[DroneCoordinates] = None
        self.current_gimbal_attitude: Optional[GimbalAttitude] = None  # 云台姿态数据
        self.latest_frame: Optional[VideoFrame] = None
        self.device_sn: Optional[str] = None
        
        # 确保video目录存在
        self._ensure_video_directory()
    
    def _ensure_video_directory(self):
        """确保video目录存在"""
        try:
            if not os.path.exists(self.video_dir):
                os.makedirs(self.video_dir)
                logger.info(f"✅ 创建视频保存目录: {self.video_dir}")
            else:
                logger.info(f"📁 视频保存目录已存在: {self.video_dir}")
        except Exception as e:
            logger.error(f"❌ 创建视频目录失败: {e}")
    
    def update_drone_status(self, status: DroneStatus):
        """更新无人机状态数据"""
        if status.coordinates:
            self.current_coordinates = status.coordinates
            self.device_sn = status.device_sn
            logger.debug(f"🔄 更新坐标数据: {status.device_sn} - lat={status.coordinates.latitude:.6f}, lon={status.coordinates.longitude:.6f}")
        
        # 更新云台姿态数据
        if status.gimbal_attitude:
            self.current_gimbal_attitude = status.gimbal_attitude
            logger.debug(f"📹 更新云台姿态: {status.device_sn} - pitch={status.gimbal_attitude.pitch:.2f}°, roll={status.gimbal_attitude.roll:.2f}°, yaw={status.gimbal_attitude.yaw:.2f}°")
        
        if not status.coordinates:
            logger.debug(f"⚠️ 状态更新但无坐标数据: {status.device_sn}")
    
    def update_video_frame(self, device_sn: str, frame: VideoFrame):
        """更新视频帧数据"""
        self.latest_frame = frame
        self.device_sn = device_sn
        logger.debug(f"🎬 更新视频帧: {device_sn} - 尺寸={frame.width}x{frame.height}, 时间戳={frame.timestamp}")
    
    def start_saving(self):
        """开始定期保存"""
        if self.is_saving:
            logger.warning("数据保存任务已在运行")
            return
        
        self.is_saving = True
        self.save_task = asyncio.create_task(self._save_loop())
        logger.info(f"🎬 启动数据保存任务，保存间隔: {self.save_interval}秒")
    
    def stop_saving(self):
        """停止保存"""
        self.is_saving = False
        if self.save_task:
            self.save_task.cancel()
        logger.info("🛑 数据保存任务已停止")
    
    async def _save_loop(self):
        """保存循环任务"""
        while self.is_saving:
            try:
                await asyncio.sleep(self.save_interval)
                
                if self.is_saving:  # 再次检查，防止在sleep期间被停止
                    await self._save_current_data()
                    
            except asyncio.CancelledError:
                logger.info("数据保存任务被取消")
                break
            except Exception as e:
                logger.error(f"❌ 数据保存循环错误: {e}")
                await asyncio.sleep(5)  # 错误后等待5秒再继续
    
    async def _save_current_data(self):
        """保存当前数据（视频帧和坐标）"""
        try:
            # 检查是否有数据可保存 - 添加详细的调试信息
            missing_data = []
            if not self.latest_frame:
                missing_data.append("视频帧(latest_frame)")
            if not self.current_coordinates:
                missing_data.append("坐标数据(current_coordinates)")
            if not self.device_sn:
                missing_data.append("设备序列号(device_sn)")
            
            if missing_data:
                logger.warning(f"⚠️ 缺少必要数据，跳过本次保存: {', '.join(missing_data)}")
                logger.debug(f"当前状态 - 设备SN: {self.device_sn}, 有坐标: {self.current_coordinates is not None}, 有视频帧: {self.latest_frame is not None}")
                return
            
            # 生成时间戳文件名
            timestamp = datetime.now()
            timestamp_str = timestamp.strftime("%Y%m%d_%H%M%S")
            
            # 保存视频帧
            image_filename = f"{self.device_sn}_{timestamp_str}.jpg"
            image_path = os.path.join(self.video_dir, image_filename)
            
            # 将视频帧数据写入文件
            with open(image_path, 'wb') as f:
                f.write(self.latest_frame.frame_data)
            
            # 保存坐标数据
            coords_filename = f"{self.device_sn}_{timestamp_str}_coords.json"
            coords_path = os.path.join(self.video_dir, coords_filename)
            
            coords_data = {
                "device_sn": self.device_sn,
                "timestamp": timestamp.isoformat(),
                "coordinates": {
                    "latitude": self.current_coordinates.latitude,
                    "longitude": self.current_coordinates.longitude,
                    "altitude": self.current_coordinates.altitude,
                    "heading": self.current_coordinates.heading,
                    "pitch": self.current_coordinates.pitch,
                    "roll": self.current_coordinates.roll,
                    "data_timestamp": self.current_coordinates.timestamp
                },
                "gimbal_attitude": {  # 云台姿态数据 - 参考DJI Demo
                    "pitch": self.current_gimbal_attitude.pitch if self.current_gimbal_attitude else 0.0,
                    "roll": self.current_gimbal_attitude.roll if self.current_gimbal_attitude else 0.0,
                    "yaw": self.current_gimbal_attitude.yaw if self.current_gimbal_attitude else 0.0,
                    "data_timestamp": self.current_gimbal_attitude.timestamp if self.current_gimbal_attitude else timestamp.timestamp()
                },
                "video_frame": {
                    "width": self.latest_frame.width,
                    "height": self.latest_frame.height,
                    "format": self.latest_frame.format,
                    "frame_timestamp": self.latest_frame.timestamp,
                    "image_file": image_filename
                }
            }
            
            with open(coords_path, 'w', encoding='utf-8') as f:
                json.dump(coords_data, f, indent=2, ensure_ascii=False)
            
            logger.info(f"💾 数据保存成功: {image_filename}")
            logger.info(f"📍 坐标: lat={self.current_coordinates.latitude:.6f}, "
                       f"lon={self.current_coordinates.longitude:.6f}, "
                       f"alt={self.current_coordinates.altitude:.2f}m")
            
            # 记录云台姿态信息（如果有效）
            if self.current_gimbal_attitude and any([
                self.current_gimbal_attitude.pitch != 0.0,
                self.current_gimbal_attitude.roll != 0.0, 
                self.current_gimbal_attitude.yaw != 0.0
            ]):
                logger.info(f"📹 云台姿态: pitch={self.current_gimbal_attitude.pitch:.2f}°, "
                           f"roll={self.current_gimbal_attitude.roll:.2f}°, "
                           f"yaw={self.current_gimbal_attitude.yaw:.2f}°")
            
        except Exception as e:
            logger.error(f"❌ 保存数据失败: {e}")
    
    def get_save_status(self) -> Dict[str, Any]:
        """获取保存状态信息"""
        return {
            "is_saving": self.is_saving,
            "save_interval": self.save_interval,
            "video_dir": self.video_dir,
            "has_coordinates": self.current_coordinates is not None,
            "has_gimbal_attitude": self.current_gimbal_attitude is not None,
            "has_video_frame": self.latest_frame is not None,
            "device_sn": self.device_sn
        }

class VideoRecorder:
    """视频录制器 - 可选的连续视频录制功能"""
    
    def __init__(self, device_sn: str):
        self.device_sn = device_sn
        self.video_dir = "video"
        self.is_recording = False
        self.video_writer = None
        self.current_filename = None
        
        # 视频参数
        self.fps = 10
        self.codec = cv2.VideoWriter_fourcc(*'mp4v')
    
    def start_recording(self, width: int = 640, height: int = 480):
        """开始录制视频"""
        try:
            if self.is_recording:
                logger.warning("视频录制已在进行中")
                return False
            
            # 生成文件名
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.current_filename = f"{self.device_sn}_{timestamp}.mp4"
            video_path = os.path.join(self.video_dir, self.current_filename)
            
            # 创建VideoWriter
            self.video_writer = cv2.VideoWriter(
                video_path, self.codec, self.fps, (width, height)
            )
            
            if not self.video_writer.isOpened():
                logger.error("❌ 无法创建视频写入器")
                return False
            
            self.is_recording = True
            logger.info(f"🎥 开始录制视频: {self.current_filename}")
            return True
            
        except Exception as e:
            logger.error(f"❌ 启动视频录制失败: {e}")
            return False
    
    def add_frame(self, frame_data: bytes):
        """添加视频帧"""
        try:
            if not self.is_recording or not self.video_writer:
                return
            
            # 将字节数据转换为OpenCV图像
            nparr = np.frombuffer(frame_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is not None:
                self.video_writer.write(frame)
            
        except Exception as e:
            logger.error(f"❌ 添加视频帧失败: {e}")
    
    def stop_recording(self):
        """停止录制视频"""
        try:
            if not self.is_recording:
                return
            
            self.is_recording = False
            
            if self.video_writer:
                self.video_writer.release()
                self.video_writer = None
            
            logger.info(f"✅ 视频录制已停止: {self.current_filename}")
            
        except Exception as e:
            logger.error(f"❌ 停止视频录制失败: {e}")
