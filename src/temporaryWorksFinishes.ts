// Procedural textures in design metres. Anti-alias fine joints/ribs as they move below one pixel.
export const finishVertexShader = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
in vec3 twSurface;
out vec4 v_color;
out vec3 v_surface;
out vec3 v_eye;
void main() {
  vec4 p=czm_computePosition();
  v_eye=(czm_modelViewRelativeToEye*p).xyz;
  v_surface=twSurface;
  v_color=color;
  gl_Position=czm_modelViewProjectionRelativeToEye*p;
}`;
export const finishFragmentShader = `
in vec4 v_color;
in vec3 v_surface;
in vec3 v_eye;
float hash2(vec2 p) {
  vec3 p3=fract(vec3(p.xyx)*.1031);
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
float noise2(vec2 p) {
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash2(i),hash2(i+vec2(1.,0.)),f.x),
             mix(hash2(i+vec2(0.,1.)),hash2(i+1.),f.x),f.y)-.5;
}
float seam(float x,float repeatM,float width) {
  float d=abs(fract(x/repeatM+.5)-.5)*repeatM;
  float px=max(.0001,fwidth(x));
  return (1.-smoothstep(width*.4, width+px*.8,d))*min(1.,width/px);
}
void main(){
  vec2 m=v_surface.xy;
  float k=v_surface.z;
  vec3 rgb=v_color.rgb;
  vec3 n=cross(dFdx(v_eye),dFdy(v_eye));
  float light=abs(dot(n*inversesqrt(max(dot(n,n),1.e-15)),normalize(vec3(-.35,.65,.68))));
  float tone=.87+.17*light;
  float fade=1.-smoothstep(.025,.24,max(fwidth(m.x),fwidth(m.y)));
  if(k>.5 && k<2.5) {
    // Road UV = source chainage and signed offset; a single joint pattern spans all GPU chunks.
    tone+=.095*noise2(m*.55)+fade*(.09*noise2(m*25.)+.018*sin(m.x*83.));
    float joints=seam(m.x,4.5,.019);
    if(k>1.5)joints=max(joints,seam(m.y,4.5,.019));
    tone-=.37*joints;
    if(k<1.5){float d=(abs(m.y)-.95)/.27;tone-=.035*exp(-d*d);}
  } else if(k>2.5 && k<4.5) {
    tone+=.18*noise2(m*.9)+fade*.27*noise2(m*14.);
  } else if(k>4.5 && k<5.5) {
    tone+=.055*noise2(m*.35);
    tone-=.22*seam(m.x,.28,.035);
  }
  out_FragColor=czm_gammaCorrect(vec4(clamp(rgb*tone,0.,1.),v_color.a));
}`;
