import * as THREE from 'three';
// Optional independent geometry, no image or branded asset. Rotation follows the model.
export function createParticleRing(){
 const group=new THREE.Group(),vertices=[];
 const point=(r,a)=>[r*Math.cos(a),r*Math.sin(a),0];
 for(let i=0;i<360;i++)vertices.push(...point(.86,i*Math.PI/180),...point(.86,(i+1)*Math.PI/180));
 for(let i=0;i<96;i++){const a=i*Math.PI/48;vertices.push(...point(1.01,a),...point(1.045,a))}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
 const material=new THREE.LineBasicMaterial({color:0x959894,transparent:true,opacity:.65,depthWrite:false,depthTest:false});
 group.add(new THREE.LineSegments(geometry,material));
 const arcMaterial=new THREE.MeshBasicMaterial({color:0x959894,transparent:true,opacity:.65,depthWrite:false,depthTest:false,side:THREE.DoubleSide});
 for(let i=0;i<4;i++)group.add(new THREE.Mesh(new THREE.RingGeometry(1.015,1.04,32,1,i*Math.PI/2+.12,.52),arcMaterial));
 group.renderOrder=-1;group.traverse(o=>o.renderOrder=-1);
 group.dispose=()=>{const seen=new Set();group.traverse(o=>{for(const r of [o.geometry,o.material])if(r&&!seen.has(r)){seen.add(r);r.dispose()}})};
 return group;
}
