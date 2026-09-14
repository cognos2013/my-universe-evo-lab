import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGrid } from '../simulation/environment/grid.ts';
import type { Projection } from '../workers/controller.ts';

export type Layer = 'terrain'|'temperature'|'biomass'|'nutrient'|'lineage';
export class PlanetView {
  #renderer:THREE.WebGLRenderer; #scene=new THREE.Scene(); #camera=new THREE.PerspectiveCamera(40,1,0.01,100);
  #controls:OrbitControls; #mesh:THREE.Mesh; #geometry=new THREE.BufferGeometry();
  #data:Projection|null=null; #layer:Layer='terrain'; #selected=-1;
  #raycaster=new THREE.Raycaster(); #container:HTMLElement; #count=0;
  #frames=0;
  #highlight=new THREE.LineLoop(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:0.9}));
  constructor(container:HTMLElement,onSelect:(id:number)=>void){
    this.#container=container;
    this.#renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.#renderer.setClearColor(0x080e17,0);
    this.#renderer.outputColorSpace=THREE.SRGBColorSpace;
    container.appendChild(this.#renderer.domElement);
    this.#camera.position.set(0,0.25,3.5);
    this.#controls=new OrbitControls(this.#camera,this.#renderer.domElement);this.#controls.enableDamping=true;this.#controls.enablePan=false;this.#controls.minDistance=1.12;this.#controls.maxDistance=6;this.#controls.rotateSpeed=0.6;
    this.#scene.add(new THREE.AmbientLight(0xa6d8e5,1.3));
    const light=new THREE.DirectionalLight(0xddefff,2.7);light.position.set(-3,3,4);this.#scene.add(light);
    const rim=new THREE.DirectionalLight(0x48b4a8,0.8);rim.position.set(2,0,-2);this.#scene.add(rim);
    this.#mesh=new THREE.Mesh(this.#geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.84,metalness:0.05,flatShading:false}));this.#scene.add(this.#mesh,this.#highlight);
    const halo=new THREE.Mesh(new THREE.SphereGeometry(1.025,48,32),new THREE.MeshBasicMaterial({color:0x39bfae,transparent:true,opacity:0.055,side:THREE.BackSide}));this.#scene.add(halo);
    const ringPoints=Array.from({length:160},(_,i)=>{const a=i/160*Math.PI*2;return new THREE.Vector3(Math.cos(a)*1.42,Math.sin(a)*0.18,Math.sin(a)*1.42);});
    const ring=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPoints),new THREE.LineBasicMaterial({color:0x254250,transparent:true,opacity:0.55}));this.#scene.add(ring);
    let seed=1937;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const stars=Float32Array.from({length:900},()=> (random()-0.5)*16);
    const starGeometry=new THREE.BufferGeometry();starGeometry.setAttribute('position',new THREE.BufferAttribute(stars,3));
    this.#scene.add(new THREE.Points(starGeometry,new THREE.PointsMaterial({size:0.013,color:0x789ab8,transparent:true,opacity:0.5})));
    let down=[0,0];
    container.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
    container.addEventListener('pointerup',e=>{
      if(Math.hypot(e.clientX-down[0]!,e.clientY-down[1]!)>5)return;
      const rect=this.#renderer.domElement.getBoundingClientRect();
      this.#raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),this.#camera);
      const hit=this.#raycaster.intersectObject(this.#mesh)[0];
      if(hit?.faceIndex!==undefined&&hit.faceIndex!==null){this.select(hit.faceIndex);onSelect(hit.faceIndex);}
    });
    new ResizeObserver(()=>this.#resize()).observe(container);this.#resize();
    this.#renderer.setAnimationLoop(()=>{this.#controls.update();this.#renderer.render(this.#scene,this.#camera);this.#renderer.domElement.dataset.renderedFrames=String(++this.#frames);});
  }
  #resize(){const w=this.#container.clientWidth,h=this.#container.clientHeight;if(!w||!h)return;this.#renderer.setSize(w,h);this.#camera.aspect=w/h;this.#camera.updateProjectionMatrix();}
  update(data:Projection){
    this.#data=data;
    if(this.#count!==data.temperature.length){
      this.#count=data.temperature.length;const grid=createGrid(this.#count,1);
      const positions=new Float32Array(this.#count*9);
      grid.faces.forEach((face,i)=>face.forEach((vertex,j)=>positions.set(grid.vertices[vertex]!,i*9+j*3)));
      this.#geometry.dispose();this.#geometry=new THREE.BufferGeometry();this.#geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));this.#geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(positions.length),3));this.#geometry.setAttribute('normal',new THREE.BufferAttribute(positions.slice(),3));this.#mesh.geometry=this.#geometry;this.#selected=-1;this.#highlight.visible=false;
    }
    this.#paint();
  }
  setLayer(layer:Layer){this.#layer=layer;this.#paint();}
  /**
   * Set the camera state (position, look-at target, fov).
   * Used by the level manager (Phase 11.1) when transitioning
   * between COSMOS / GALAXY / PLANET / SURFACE. The next
   * animation frame picks up the new state. Pass the planet's
   * default lookAt to "center" the view.
   */
  setCameraState(position:{x:number;y:number;z:number},lookAt:{x:number;y:number;z:number},fov:number){
    this.#camera.position.set(position.x,position.y,position.z);
    this.#camera.lookAt(lookAt.x,lookAt.y,lookAt.z);
    this.#camera.fov=fov;this.#camera.updateProjectionMatrix();
    this.#controls.target.set(lookAt.x,lookAt.y,lookAt.z);
    this.#controls.update();
  }
  /**
   * Read the current camera state. The level manager uses this
   * as the "from" of the next transition so the user doesn't
   * snap if they manually orbited the planet first.
   */
  getCameraState():{position:{x:number;y:number;z:number};lookAt:{x:number;y:number;z:number};fov:number}{
    return {
      position:{x:this.#camera.position.x,y:this.#camera.position.y,z:this.#camera.position.z},
      lookAt:{x:this.#controls.target.x,y:this.#controls.target.y,z:this.#controls.target.z},
      fov:this.#camera.fov,
    };
  }
  select(cell:number){this.#selected=cell;const p=this.#geometry.getAttribute('position');if(cell<0||cell>=this.#count)return;const points=[0,1,2].map(i=>new THREE.Vector3().fromBufferAttribute(p,cell*3+i).multiplyScalar(1.001));this.#highlight.geometry.dispose();this.#highlight.geometry=new THREE.BufferGeometry().setFromPoints(points);this.#highlight.visible=true;}
  #paint(){
    const d=this.#data;if(!d)return;
    const colors=this.#geometry.getAttribute('color');const color=new THREE.Color();
    const maxBio=Math.max(1,...d.biomass),maxNutrient=Math.max(1,...d.nutrient);
    for(let i=0;i<this.#count;i++){
      if(this.#layer==='terrain'){
        color.set(d.land[i]!>.5?0x758360:0x165b70);
        color.multiplyScalar(0.86+0.14*(Math.sin(i*1.37)*.5+.5));
      }else if(this.#layer==='temperature'){const t=Math.max(0,Math.min(1,(d.temperature[i]!-260)/60));color.setHSL((1-t)*.62,.67,.39);}
      else if(this.#layer==='biomass'){const t=Math.log1p(d.biomass[i]!)/Math.log1p(maxBio);color.setHSL(.46,.5,.08+t*.48);}
      else if(this.#layer==='nutrient'){const t=d.nutrient[i]!/maxNutrient;color.setHSL(.105,.55,.09+t*.46);}
      else {const id=d.dominant[i]!;if(id<0)color.set(0x152b3b);else color.setHSL((id*.61803398875)%1,.45,.45);}
      for(let vertex=0;vertex<3;vertex++)colors.setXYZ(i*3+vertex,color.r,color.g,color.b);
    }
    colors.needsUpdate=true;
  }
}
