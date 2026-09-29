"""
兼容保留的旧视频流模块。

当前服务入口使用 video_processor.py 的有界采样实现。
"""
import asyncio
import logging
import time
import threading
import cv2
import numpy as np
from typing import Optional, Callable, Dict, Any
from .config import config
from .models import VideoFrame

logger = logging.getLogger(__name__)

class VideoStreamer:
    """视频流处理器，负责从RTMP流获取视频帧 - 支持循环重试"""
    
    def __init__(self, device_sn: str):
        self.device_sn = device_sn
        self.rtmp_url = config.rtmp.get_stream_url(device_sn)
        self.cap = None
        self.is_streaming = False
        self.frame_callback: Optional[Callable[[VideoFrame], None]] = None
        self.stream_thread = None
        self.retry_count = 0
        self.max_retries = 0  # 0表示无限重试
        self.retry_interval = 5  # 重试间隔秒数
        
    def set_frame_callback(self, callback: Callable[[VideoFrame], None]):
        """设置帧回调函数"""
        self.frame_callback = callback
    
    def start_streaming(self) -> bool:
        """开始视频流 - 立即启动重试线程"""
        if self.is_streaming:
            logger.warning(f"设备 {self.device_sn} 视频流已在运行")
            return True
            
        self.is_streaming = True
        self.retry_count = 0
        
        # 启动视频处理线程（包含重试逻辑）
        self.stream_thread = threading.Thread(target=self._retry_and_stream_loop, daemon=True)
        self.stream_thread.start()
        
        logger.info(f"🎬 启动视频流重试任务: {self.rtmp_url}")
        return True
    
    def _retry_and_stream_loop(self):
        """重试连接并处理视频流的主循环"""
        while self.is_streaming:
            try:
                # 尝试连接视频流
                if self._attempt_connection():
                    logger.info(f"✅ 视频流连接成功: {self.rtmp_url}")
                    # 开始处理视频帧
                    self._stream_loop()
                else:
                    # 连接失败，等待重试
                    self.retry_count += 1
                    if self.max_retries > 0 and self.retry_count >= self.max_retries:
                        logger.error(f"❌ 视频流连接失败，达到最大重试次数 {self.max_retries}")
                        break
                    
                    logger.warning(f"⏳ 视频流连接失败，{self.retry_interval}秒后进行第{self.retry_count + 1}次重试...")
                    time.sleep(self.retry_interval)
                    
            except Exception as e:
                logger.error(f"❌ 视频流处理异常: {e}")
                time.sleep(self.retry_interval)
        
        logger.info(f"视频流处理线程结束: {self.device_sn}")
    
    def _attempt_connection(self) -> bool:
        """尝试连接视频流"""
        try:
            logger.info(f"🔄 尝试连接视频流: {self.rtmp_url}")
            
            # 释放之前的连接
            if self.cap:
                self.cap.release()
                self.cap = None
            
            # 创建新的VideoCapture对象
            self.cap = cv2.VideoCapture(self.rtmp_url)
            
            # 设置属性
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            self.cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10000)  # 10秒超时
            
            # 检查是否成功打开
            if not self.cap.isOpened():
                logger.warning(f"❌ 无法打开视频流: {self.rtmp_url}")
                return False
            
            # 尝试读取一帧来验证流的有效性
            ret, test_frame = self.cap.read()
            if not ret or test_frame is None:
                logger.warning(f"❌ 视频流无效或无数据: {self.rtmp_url}")
                self.cap.release()
                self.cap = None
                return False
            
            logger.info(f"✅ 视频流验证成功，帧尺寸: {test_frame.shape}")
            return True
            
        except Exception as e:
            logger.error(f"❌ 连接视频流失败: {e}")
            if self.cap:
                self.cap.release()
                self.cap = None
            return False
    
    def stop_streaming(self):
        """停止视频流"""
        logger.info(f"🛑 停止视频流: {self.device_sn}")
        self.is_streaming = False
        
        # 等待线程结束
        if self.stream_thread and self.stream_thread.is_alive():
            self.stream_thread.join(timeout=3)
        
        # 释放资源
        if self.cap:
            self.cap.release()
            self.cap = None
        
        logger.info(f"✅ 视频流已停止: {self.device_sn}")
    
    def _stream_loop(self):
        """视频流处理循环 - 持续读取视频帧直到连接断开"""
        frame_count = 0
        last_time = time.time()
        consecutive_failures = 0
        max_consecutive_failures = 10  # 连续失败次数阈值
        
        logger.info(f"📺 开始视频帧处理循环: {self.device_sn}")
        
        while self.is_streaming and self.cap and self.cap.isOpened():
            try:
                ret, frame = self.cap.read()
                
                if not ret or frame is None:
                    consecutive_failures += 1
                    logger.warning(f"读取视频帧失败 {consecutive_failures}/{max_consecutive_failures}")
                    
                    # 如果连续失败次数过多，跳出循环重新连接
                    if consecutive_failures >= max_consecutive_failures:
                        logger.warning("连续读取失败次数过多，准备重新连接...")
                        break
                    
                    time.sleep(0.1)
                    continue
                
                # 重置连续失败计数
                consecutive_failures = 0
                
                # 调整帧大小
                frame = cv2.resize(frame, (config.video.frame_width, config.video.frame_height))
                
                # 转换为JPEG
                encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), config.video.quality]
                _, buffer = cv2.imencode('.jpg', frame, encode_param)
                
                # 创建视频帧对象
                video_frame = VideoFrame(
                    frame_data=buffer.tobytes(),
                    timestamp=time.time(),
                    width=config.video.frame_width,
                    height=config.video.frame_height,
                    format="jpeg"
                )
                
                # 调用回调函数
                if self.frame_callback:
                    self.frame_callback(video_frame)
                
                # 控制帧率
                frame_count += 1
                current_time = time.time()
                elapsed = current_time - last_time
                
                if elapsed < 1.0 / config.video.fps:
                    time.sleep(1.0 / config.video.fps - elapsed)
                
                # 每30帧统计一次
                if frame_count % 30 == 0:
                    actual_fps = 30 / (current_time - last_time + 0.001)
                    logger.debug(f"📊 设备 {self.device_sn} 视频流正常，实际帧率: {actual_fps:.1f} fps")
                    last_time = current_time
                
            except Exception as e:
                logger.error(f"❌ 视频流处理错误: {e}")
                consecutive_failures += 1
                if consecutive_failures >= max_consecutive_failures:
                    logger.error("视频流处理错误次数过多，准备重新连接...")
                    break
                time.sleep(0.5)
        
        # 释放当前连接
        if self.cap:
            self.cap.release()
            self.cap = None
        
        logger.info(f"📺 视频帧处理循环结束: {self.device_sn}")
    
    def is_active(self) -> bool:
        """检查视频流是否活跃"""
        return self.is_streaming and self.cap and self.cap.isOpened()

class VideoManager:
    """视频管理器，管理多个设备的视频流"""
    
    def __init__(self):
        self.streamers: dict[str, VideoStreamer] = {}
        self.frame_callback: Optional[Callable[[str, VideoFrame], None]] = None
    
    def set_frame_callback(self, callback: Callable[[str, VideoFrame], None]):
        """设置帧回调函数"""
        self.frame_callback = callback
    
    def start_stream(self, device_sn: str) -> bool:
        """启动指定设备的视频流"""
        if device_sn in self.streamers:
            logger.warning(f"设备 {device_sn} 的视频流已存在")
            return True
        
        streamer = VideoStreamer(device_sn)
        
        # 设置回调函数
        def frame_handler(frame: VideoFrame):
            if self.frame_callback:
                self.frame_callback(device_sn, frame)
        
        streamer.set_frame_callback(frame_handler)
        
        if streamer.start_streaming():
            self.streamers[device_sn] = streamer
            return True
        
        return False
    
    def stop_stream(self, device_sn: str):
        """停止指定设备的视频流"""
        if device_sn in self.streamers:
            self.streamers[device_sn].stop_streaming()
            del self.streamers[device_sn]
    
    def stop_all_streams(self):
        """停止所有视频流"""
        for device_sn in list(self.streamers.keys()):
            self.stop_stream(device_sn)
    
    def get_active_streams(self) -> list[str]:
        """获取活跃的视频流列表"""
        return [device_sn for device_sn, streamer in self.streamers.items() 
                if streamer.is_active()]
