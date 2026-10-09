import './photoComparison.css';
export type ComparisonPhoto = {
  id: string; name: string; url: string; objectLabel: string; capturedAt: string;
  sourceLabel: string; viewpoint?: string;
};
export type ComparisonAnnotation = { photoId: string; x: number; y: number };
export type ComparisonIssueSelection = { evidenceIds: string[]; annotations: ComparisonAnnotation[]; mode: 'side-by-side'|'slider' };
export type PhotoComparisonOptions = { photos: readonly [ComparisonPhoto, ComparisonPhoto]; onIssue?(selection: ComparisonIssueSelection): void; onClose?(): void };
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));
/** Modal owns only its image nodes and event handlers, never business data or videos. */
export class PhotoComparison {
  private dialog?: HTMLDialogElement;
  private events = new AbortController();
  private returnFocus?: HTMLElement;
  private mode:'side-by-side'|'slider'='side-by-side';
  private zoom=1; private pan={x:0,y:0}; private slider=50;
  private drag?:{pointerId:number;x:number;y:number;panX:number;panY:number;moved:boolean;surface:HTMLElement};
  private markPhoto?:string;
  private annotations:ComparisonAnnotation[]=[];
  private disposed=false;
  private photos:readonly [ComparisonPhoto,ComparisonPhoto];
  constructor(private options:PhotoComparisonOptions){this.photos=structuredClone(options.photos);}
  open():void {
    if(this.dialog||this.disposed)return;
    this.returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const dialog=document.createElement('dialog');this.dialog=dialog;dialog.className='mg-photo-comparison';dialog.setAttribute('aria-label','巡检照片人工对比');
    dialog.innerHTML=`<header class="mg-photo-header"><div><h2>巡检照片对比</h2><p>同工点照片用于人工核对；不自动判断质量或进度。</p></div><button type="button" data-pc="close" autofocus>返回工作台</button></header><div class="mg-photo-toolbar" aria-label="照片对比工具"><div role="group" aria-label="对比方式"><button data-pc="side-by-side" aria-pressed="true">并排对比</button><button data-pc="slider" aria-pressed="false">滑块对比</button></div><label>同步缩放 <input data-pc="zoom" type="range" min="1" max="8" step="0.1" value="1" aria-label="两张照片同步缩放"></label><output data-pc-zoom>100%</output><button data-pc="reset">恢复全图</button><span class="mg-photo-spacer"></span><button data-pc="mark-a">标注左图</button><button data-pc="mark-b">标注右图</button>${this.options.onIssue?'<button data-pc="issue" class="mg-photo-primary">关联问题</button>':''}</div><p class="mg-photo-notice" role="status" data-pc-notice></p><div class="mg-photo-meta">${this.photos.map((p,i)=>`<section><b>${i===0?'左图':'右图'} · ${esc(p.name)}</b><span>工点：${esc(p.objectLabel||'尚未关联工点')} · 拍摄日期：${esc(p.capturedAt||'尚未核验')}</span><span>原件来源：${esc(p.sourceLabel||'已归档原始附件')} · 视角：${esc(p.viewpoint||'未核验')}</span></section>`).join('')}</div><div class="mg-photo-stage" data-pc-stage data-mode="side-by-side"><div class="mg-photo-sideviews">${this.surface(0,'a')}${this.surface(1,'b')}</div><div class="mg-photo-slider-view" hidden>${this.surface(0,'slider-a')}${this.surface(1,'slider-b')}<div class="mg-photo-divider" data-pc-divider aria-hidden="true"></div><label class="mg-photo-slider-control">左右对比位置<input data-pc="position" type="range" min="0" max="100" value="50" aria-label="滑块对比位置"></label></div></div><footer class="mg-photo-footer">拖动任一照片可同步平移，滚轮缩放。键盘方向键平移，+ / − 缩放，0 恢复全图，Esc 返回。<span data-pc-annotation-count>未添加标注</span></footer>`;
    document.body.append(dialog);
    dialog.addEventListener('click',event=>this.click(event),{signal:this.events.signal});
    dialog.addEventListener('input',event=>this.input(event),{signal:this.events.signal});
    dialog.addEventListener('pointerdown',event=>this.pointerDown(event),{signal:this.events.signal});
    dialog.addEventListener('pointermove',event=>this.pointerMove(event),{signal:this.events.signal});
    dialog.addEventListener('pointerup',event=>this.pointerUp(event),{signal:this.events.signal});
    dialog.addEventListener('pointercancel',()=>this.releasePointer(),{signal:this.events.signal});
    dialog.addEventListener('wheel',event=>this.wheel(event),{signal:this.events.signal,passive:false});
    dialog.addEventListener('keydown',event=>this.key(event),{signal:this.events.signal});
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.dispose();},{signal:this.events.signal});
    dialog.addEventListener('close',()=>this.dispose(),{signal:this.events.signal});
    window.addEventListener('resize',()=>this.update(),{signal:this.events.signal});
    for(const image of dialog.querySelectorAll<HTMLImageElement>('img[data-pc-image]')){
      const photo=this.photos[Number(image.dataset.pcImage)];
      const failed=()=>{image.hidden=true;const note=image.parentElement!.querySelector<HTMLElement>('[data-pc-image-status]')!;note.hidden=false;note.textContent='原件读取失败。请确认当前账号权限和附件状态后重新打开。';};
      image.addEventListener('load',()=>{image.parentElement!.querySelector<HTMLElement>('[data-pc-image-status]')!.hidden=true;this.update();},{signal:this.events.signal});
      image.addEventListener('error',failed,{signal:this.events.signal});
      try{const url=new URL(photo.url,location.href);if(url.origin!==location.origin||url.protocol!==location.protocol)throw Error('Only authenticated same-origin evidence');image.src=url.href;}catch{failed();}
    }
    dialog.showModal();this.notice();this.update();
  }
  private surface(index:number,key:string){const photo=this.photos[index];return `<div class="mg-photo-surface" data-pc-surface="${key}" data-photo-index="${index}" aria-label="${esc(photo.name)}"><div class="mg-photo-image-wrap"><img data-pc-image="${index}" alt="${esc(photo.name)}" draggable="false"><p data-pc-image-status class="mg-photo-image-status">正在读取已授权原件…</p><div data-pc-markers></div></div></div>`;}
  private notice(text?:string){const host=this.dialog?.querySelector<HTMLElement>('[data-pc-notice]');if(host)host.textContent=text||(this.photos[0].objectLabel!==this.photos[1].objectLabel?'两张照片的工点标注不同，请先人工核对对象。':this.photos[0].viewpoint&&this.photos[1].viewpoint&&this.photos[0].viewpoint!==this.photos[1].viewpoint?'两张照片的拍摄视角不同。':'拍摄视角尚需人工核验。')+' 同步缩放与平移不等于精确图像配准。';}
  private click(event:MouseEvent){const target=(event.target as Element).closest<HTMLElement>('[data-pc]');if(!target)return;const action=target.dataset.pc;
    if(action==='close')this.dispose();
    else if(action==='side-by-side'||action==='slider'){this.mode=action;this.markPhoto=undefined;this.notice();this.releasePointer();this.update();}
    else if(action==='reset'){this.zoom=1;this.pan={x:0,y:0};this.markPhoto=undefined;this.notice();this.update();}
    else if(action==='mark-a'||action==='mark-b'){this.markPhoto=this.photos[action==='mark-a'?0:1].id;this.notice(`请在${action==='mark-a'?'左':'右'}图的实际照片范围点击标注。标注只记录人工观察位置。`);this.update();}
    else if(action==='issue'){const selection:ComparisonIssueSelection={evidenceIds:this.photos.map(p=>p.id),annotations:structuredClone(this.annotations),mode:this.mode};const callback=this.options.onIssue;this.dispose();callback?.(selection);}
  }
  private input(event:Event){const input=event.target as HTMLInputElement;if(input.dataset.pc==='zoom'){this.zoom=clamp(Number(input.value)||1,1,8);this.limitPan();this.update();}else if(input.dataset.pc==='position'){this.slider=clamp(Number(input.value)||0,0,100);this.update();}}
  private pointerDown(event:PointerEvent){if(event.button!==0||(event.target as Element).closest('button,input,label'))return;const surface=(event.target as Element).closest<HTMLElement>('[data-pc-surface]');if(!surface)return;event.preventDefault();surface.setPointerCapture(event.pointerId);this.drag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,panX:this.pan.x,panY:this.pan.y,moved:false,surface};}
  private pointerMove(event:PointerEvent){const drag=this.drag;if(!drag||drag.pointerId!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved ||= Math.hypot(dx,dy)>4;if(this.markPhoto)return;const rect=drag.surface.getBoundingClientRect();this.pan={x:drag.panX+dx/Math.max(1,rect.width),y:drag.panY+dy/Math.max(1,rect.height)};this.limitPan();this.update();}
  private pointerUp(event:PointerEvent){const drag=this.drag;if(!drag||drag.pointerId!==event.pointerId)return;if(!drag.moved&&this.markPhoto)this.mark(event,drag.surface);this.releasePointer();}
  private releasePointer(){const drag=this.drag;this.drag=undefined;if(drag?.surface.hasPointerCapture(drag.pointerId))drag.surface.releasePointerCapture(drag.pointerId);}
  private mark(event:PointerEvent,surface:HTMLElement){const photo=this.photos.find(p=>p.id===this.markPhoto)!;const index=this.photos.indexOf(photo);if(Number(surface.dataset.photoIndex)!==index){this.notice('请在刚选择的那张照片中标注。');return;}const visible=this.dialog!.querySelector<HTMLImageElement>(`[data-pc-surface="${this.mode==='slider'?(index?'slider-b':'slider-a'):(index?'b':'a')}"] img`)!;const rect=surface.getBoundingClientRect();if(!visible.naturalWidth||visible.hidden){this.notice('原件尚未成功读取，不能添加标注。');return;}const fit=Math.min(rect.width/visible.naturalWidth,rect.height/visible.naturalHeight),width=visible.naturalWidth*fit*this.zoom,height=visible.naturalHeight*fit*this.zoom;const x=(event.clientX-rect.left-rect.width/2-this.pan.x*rect.width)/width+.5,y=(event.clientY-rect.top-rect.height/2-this.pan.y*rect.height)/height+.5;if(x<0||x>1||y<0||y>1){this.notice('点击位于照片外空白处，未添加标注。');return;}this.annotations=this.annotations.filter(a=>a.photoId!==photo.id);this.annotations.push({photoId:photo.id,x,y});this.markPhoto=undefined;this.notice('已记录人工标注，可点击“关联问题”将两份证据交给问题表单；尚未保存业务记录。');this.update();}
  private limitPan(){const max=(this.zoom-1)/2;this.pan.x=clamp(this.pan.x,-max,max);this.pan.y=clamp(this.pan.y,-max,max);}
  private wheel(event:WheelEvent){if(!(event.target as Element).closest('[data-pc-stage]'))return;event.preventDefault();this.zoom=clamp(this.zoom*(event.deltaY<0?1.12:1/1.12),1,8);this.limitPan();this.update();}
  private key(event:KeyboardEvent){if((event.target as Element).matches('input,textarea,select'))return;const step=.04/this.zoom;if(event.key==='ArrowLeft')this.pan.x-=step;else if(event.key==='ArrowRight')this.pan.x+=step;else if(event.key==='ArrowUp')this.pan.y-=step;else if(event.key==='ArrowDown')this.pan.y+=step;else if(event.key==='+'||event.key==='=')this.zoom=clamp(this.zoom+.25,1,8);else if(event.key==='-')this.zoom=clamp(this.zoom-.25,1,8);else if(event.key==='0'){this.zoom=1;this.pan={x:0,y:0};}else return;event.preventDefault();this.limitPan();this.update();}
  private update(){const dialog=this.dialog;if(!dialog)return;dialog.querySelector<HTMLElement>('[data-pc-stage]')!.dataset.mode=this.mode;dialog.querySelector<HTMLElement>('.mg-photo-sideviews')!.hidden=this.mode!=='side-by-side';dialog.querySelector<HTMLElement>('.mg-photo-slider-view')!.hidden=this.mode!=='slider';for(const button of dialog.querySelectorAll<HTMLElement>('[data-pc="side-by-side"],[data-pc="slider"]'))button.setAttribute('aria-pressed',String(button.dataset.pc===this.mode));dialog.querySelector<HTMLInputElement>('[data-pc="zoom"]')!.value=String(this.zoom);dialog.querySelector('[data-pc-zoom]')!.textContent=Math.round(this.zoom*100)+'%';dialog.querySelector<HTMLElement>('[data-pc-surface="slider-b"]')!.style.clipPath=`inset(0 0 0 ${this.slider}%)`;dialog.querySelector<HTMLElement>('[data-pc-divider]')!.style.left=this.slider+'%';
    for(const surface of dialog.querySelectorAll<HTMLElement>('[data-pc-surface]')){const image=surface.querySelector<HTMLImageElement>('img')!,index=Number(surface.dataset.photoIndex),photo=this.photos[index],rect=surface.getBoundingClientRect();image.style.transform=`translate(${this.pan.x*100}%,${this.pan.y*100}%) scale(${this.zoom})`;const markers=surface.querySelector<HTMLElement>('[data-pc-markers]')!;markers.replaceChildren();if(!image.naturalWidth||!rect.width)continue;const fit=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight),width=image.naturalWidth*fit*this.zoom,height=image.naturalHeight*fit*this.zoom;for(const annotation of this.annotations.filter(a=>a.photoId===photo.id)){const mark=document.createElement('span');mark.className='mg-photo-marker';mark.textContent='+';mark.style.left=(rect.width/2+this.pan.x*rect.width+(annotation.x-.5)*width)+'px';mark.style.top=(rect.height/2+this.pan.y*rect.height+(annotation.y-.5)*height)+'px';mark.title='人工标注';markers.append(mark);}surface.classList.toggle('is-marking',this.markPhoto===photo.id);}
    dialog.querySelector('[data-pc-annotation-count]')!.textContent=this.annotations.length?`${this.annotations.length} 处人工标注 · 尚未保存问题`:'未添加标注';
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.releasePointer();this.events.abort();const dialog=this.dialog;this.dialog=undefined;if(dialog){for(const image of dialog.querySelectorAll('img'))image.removeAttribute('src');if(document.fullscreenElement===dialog)void document.exitFullscreen().catch(()=>{});if(dialog.open)dialog.close();dialog.remove();}if(this.returnFocus?.isConnected)this.returnFocus.focus();this.photos=[] as unknown as readonly [ComparisonPhoto,ComparisonPhoto];this.annotations=[];this.options.onClose?.();}
}
