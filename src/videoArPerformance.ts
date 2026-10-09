import type { TextureFrameIdentity } from './videoArTextureFrame.ts';
export type VideoMetricStream='decodedFrameCallbacks'|'pairedCommits'|'renderedProjectionFrames'|'cesiumRenders';
type Samples={count:number;activeCount:number;last:number|null;lastIdentity:string|null;intervals:number[];intervalCount:number;maximumGapMs:number};
const streams:VideoMetricStream[]=['decodedFrameCallbacks','pairedCommits','renderedProjectionFrames','cesiumRenders'];
const fresh=():Samples=>({count:0,activeCount:0,last:null,lastIdentity:null,intervals:[],intervalCount:0,maximumGapMs:0});
const key=(frame:TextureFrameIdentity)=>[frame.sourceSession,frame.kind,frame.frameKey,frame.mediaTimeMs].join('|');
/** Instrumentation only. It never advances media, camera or depth, and is bounded to 20k intervals/stream. */
export class VideoArPerformance {
  private samples=Object.fromEntries(streams.map(s=>[s,fresh()])) as Record<VideoMetricStream,Samples>;
  private active=false;private activeStart=0;private activeElapsed=0;private started:number;
  private rejected:Record<string,number>={};private lastRejected=new Map<string,string>();
  private invalidations:Record<string,number>={};private callbackGaps=0;private lastPresented:number|null=null;
  constructor(now=performance.now()){this.started=now;}
  setActive(active:boolean,now=performance.now()){
    if(active===this.active)return;
    if(this.active){this.activeElapsed+=Math.max(0,now-this.activeStart);for(const s of Object.values(this.samples))s.maximumGapMs=Math.max(s.maximumGapMs,now-(s.last??this.activeStart));}
    this.active=active;this.activeStart=now;
    for(const s of Object.values(this.samples))s.last=null;
    this.lastPresented=null;
  }
  mark(stream:VideoMetricStream,now=performance.now(),frame?:TextureFrameIdentity){
    const s=this.samples[stream],identity=frame?key(frame):null;
    if(identity!==null&&s.lastIdentity===identity)return false;
    s.lastIdentity=identity;s.count++;
    if(this.active){s.activeCount++;const gap=Math.max(0,now-(s.last??this.activeStart));s.maximumGapMs=Math.max(s.maximumGapMs,gap);if(s.last!==null){s.intervals.push(gap);s.intervalCount++;if(s.intervals.length>20000)s.intervals.shift();}s.last=now;}
    return true;
  }
  decoded(now:number,frame:TextureFrameIdentity,presentedFrames?:number){
    this.mark('decodedFrameCallbacks',now,frame);
    if(this.active&&presentedFrames!==undefined&&Number.isFinite(presentedFrames)){
      if(this.lastPresented!==null&&presentedFrames>this.lastPresented)this.callbackGaps+=Math.max(0,presentedFrames-this.lastPresented-1);
      this.lastPresented=presentedFrames;
    }
  }
  reject(reason:string,frame?:TextureFrameIdentity){const identity=frame?key(frame):null;if(identity!==null&&this.lastRejected.get(reason)===identity)return;this.rejected[reason]=(this.rejected[reason]??0)+1;if(identity!==null)this.lastRejected.set(reason,identity);}
  invalidate(reason:string){this.invalidations[reason]=(this.invalidations[reason]??0)+1;}
  snapshot(now=performance.now()){
    const activeDurationMs=this.activeElapsed+(this.active?Math.max(0,now-this.activeStart):0);
    const measurements=Object.fromEntries(streams.map(stream=>{const s=this.samples[stream],sorted=[...s.intervals].sort((a,b)=>a-b);return[stream,{count:s.count,activeCount:s.activeCount,averageFps:activeDurationMs>0?s.activeCount*1000/activeDurationMs:null,p95IntervalMs:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,longestGapMs:Math.max(s.maximumGapMs,this.active?Math.max(0,now-(s.last??this.activeStart)):0),intervalsObserved:s.intervalCount,intervalsRetained:s.intervals.length,intervalsTruncated:s.intervalCount>s.intervals.length}];}));
    return{schema:'video-ar-performance/v1',elapsedMs:Math.max(0,now-this.started),activeDurationMs,active:this.active,...measurements,rejectedFrames:{...this.rejected},invalidations:{...this.invalidations},missedPresentedCallbacks:this.callbackGaps,scope:'Active media playback only for rates/gaps; totals include still frames. Paired commits are not rendered frames; rendered projection requires current source depth. RVFC observes decoded/presented availability, not internal hardware decoder throughput. Gap counts do not measure geographic accuracy.'};
  }
}

/** Preserve deadline phase when source FPS does not divide the requested rate (30→24 must not collapse to 15). */
export function projectionTick(now:number,previous:number,fps:number,force=false){
 const interval=1000/fps;
 const due=force||Number.isFinite(interval)&&interval>0&&now-previous>=interval;
 return{due,next:due?(force||previous<=0?now:now-((now-previous)%interval)):previous};
}
