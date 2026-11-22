import type { MarkTextureFormat } from './device';
// All geometry entering the shaders is integer device pixels or sorted window indices.
// Colors are straight RGBA bytes as in ImageData. The image receives premultiplied RGBA, and holds
// the pane transposed, as the Canvas 2D and WebGL2 paths retain theirs: pixel (x, y) of the pane is
// texel (y, x), so every path composites its image with the same transposed drawImage. The lanes of
// a column kernel then also store neighboring texels of a row.
const common = (format: MarkTextureFormat) => `
struct View { width:u32, height:u32, left:u32, right:u32, size:u32, rows:u32, bandCount:u32, spare:u32, table:u32, rowBase:u32, pad0:u32, pad1:u32 }
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var<storage,read> data:array<u32>;
@group(0) @binding(2) var<storage,read> spans:array<u32>;
@group(0) @binding(3) var<storage,read> style:array<u32>;
@group(0) @binding(4) var image:texture_storage_2d<${format},write>;
fn color(bits:u32)->vec4f {
	let c = unpack4x8unorm(bits);
	return vec4f(c.rgb*c.a,c.a);
}
`;

// The cells of a heatmap column: `rows` from grid row 0 each, or, where the grid follows the price,
// those a table in `spans` gives from word `table` on (where its cells start, its first grid row
// plus 2^30, its number of cells). Grid rows count from `rowBase` (plus 2^30).
const heatCells = `
fn cells(c:u32, low:u32, high:u32)->vec2u {
	if (v.table==0xffffffffu) {return vec2u(c*v.rows+low,c*v.rows+high);}
	let t=v.table+c*3u;
	let first=i32(spans[t+1u])-i32(v.rowBase);
	let lo=max(i32(low),first);
	let hi=max(lo,min(i32(high),first+i32(spans[t+2u])));
	return vec2u(u32(i32(spans[t])+lo-first),u32(i32(spans[t])+hi-first));
}
`;

export const heatShader = (format: MarkTextureFormat) =>
	common(format) +
	heatCells +
	`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3u) {
	let x=v.left+gid.x; let y=gid.y;
	if (x>=v.right || y>=v.height) {return;}
	let row=(v.width+y)*2u;
	var best=0u;
	for(var c=spans[x*2u];c<spans[x*2u+1u];c++){
		let span=cells(c,spans[row],spans[row+1u]);
		for(var i=span.x;i<span.y;i++){
			let bits=data[i];
			if ((bits&0x7fffffffu)<=0x7f800000u) {
				let ordered=select(bits^0x80000000u,~bits,(bits>>31u)!=0u);
				best=max(best,ordered);
			}
		}
	}
	var slot=0u;
	if (best!=0u) {
		var lo=1u;var hi=256u;
		while(lo+1u<hi){let mid=(lo+hi)/2u;
			if(best>=style[256u+mid]){lo=mid;}else{hi=mid;}
		}
		slot=lo;
	}
	textureStore(image,vec2u(y,x),color(style[slot]));
}`;

// As the heatmap kernel, for a fixed range of values: the cells hold their palette slots, four to
// a word, and a pixel takes the color of the highest slot among its cells.
export const heatSlotsShader = (format: MarkTextureFormat) =>
	common(format) +
	heatCells +
	`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3u) {
	let x=v.left+gid.x; let y=gid.y;
	if (x>=v.right || y>=v.height) {return;}
	let row=(v.width+y)*2u;
	var slot=0u;
	for(var c=spans[x*2u];c<spans[x*2u+1u];c++){
		let span=cells(c,spans[row],spans[row+1u]);
		for(var i=span.x;i<span.y;i++){
			slot=max(slot,(data[i>>2u]>>((i&3u)*8u))&255u);
		}
	}
	textureStore(image,vec2u(y,x),color(style[slot]));
}`;

// One group owns a vertical strip. Split tall panes into strips fitting the guaranteed
// workgroup storage limit. Absolute IDs settle overlaps regardless of execution order.
export const columnShader = (format: MarkTextureFormat) =>
	common(format) +
	`
var<workgroup> winners:array<atomic<u32>,1024>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g:vec3u,@builtin(local_invocation_index) lane:u32) {
	let x=v.left+g.x; let top=g.y*1024u; let h=min(v.height-top,1024u);
	for(var id=spans[x]+lane;id<spans[x+v.size];id+=64u) {
		let y=bitcast<i32>(data[id*2u])-i32(v.size/2u)-i32(top);
		for(var r=max(y,0);r<min(y+i32(v.size),i32(h));r++){atomicMax(&winners[u32(r)],id+1u);}
	}
	workgroupBarrier();
	for(var r=lane;r<h;r+=64u){
		let last=atomicLoad(&winners[r]);
		var c=vec4f(0); if(last!=0u){c=color(data[(last-1u)*2u+1u]);}
		textureStore(image,vec2u(top+r,x),c);
	}
}`;

// As the column kernel, with one atomic per point instead of one per row it covers: a point
// takes the slot of its marker's bottom row, and each pixel takes the highest ID of the slots of
// the `size` rows from it down. Eight more slots hold the bottom rows of markers that reach past
// the strip's last row, up to the largest square the WebGPU path draws (nine pixels).
export const wideColumnShader = (format: MarkTextureFormat) =>
	common(format) +
	`
var<workgroup> winners:array<atomic<u32>,1032>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g:vec3u,@builtin(local_invocation_index) lane:u32) {
	let x=v.left+g.x; let top=g.y*1024u; let h=min(v.height-top,1024u);
	for(var id=spans[x]+lane;id<spans[x+v.size];id+=64u) {
		let bottom=bitcast<i32>(data[id*2u])-i32(v.size/2u)-i32(top)+i32(v.size)-1;
		if(bottom>=0 && bottom<i32(h+v.size-1u)){atomicMax(&winners[u32(bottom)],id+1u);}
	}
	workgroupBarrier();
	for(var r=lane;r<h;r+=64u){
		var last=0u;
		for(var dy=0u;dy<v.size;dy++){last=max(last,atomicLoad(&winners[r+dy]));}
		var c=vec4f(0); if(last!=0u){c=color(data[(last-1u)*2u+1u]);}
		textureStore(image,vec2u(top+r,x),c);
	}
}`;

// Each price band contains original IDs in time order, including markers reaching into
// it from its neighbors. The x-boundary table is shared with the column path.
export const tileShader = (format: MarkTextureFormat) =>
	common(format) +
	`
@group(0) @binding(5) var<storage,read> bands:array<u32>;
@group(0) @binding(6) var<storage,read> ids:array<u32>;
var<workgroup> tiles:array<atomic<u32>,256>;
var<workgroup> bounds:array<u32,2>;
fn lowerBound(lo0:u32,hi0:u32,threshold:u32)->u32{
	var lo=lo0;var hi=hi0;
	while(lo<hi){let mid=lo+(hi-lo)/2u;if(ids[mid]<threshold){lo=mid+1u;}else{hi=mid;}}
	return lo;
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) g:vec3u,@builtin(local_invocation_index) lane:u32) {
	let x0=v.left+g.x*16u;let y0=g.y*16u;let end=min(x0+16u,v.right);
	if (lane==0){bounds[0]=lowerBound(bands[g.y],bands[g.y+1u],spans[x0]);}
	if (lane==1){bounds[1]=lowerBound(bands[g.y],bands[g.y+1u],spans[end+v.size-1u]);}
	workgroupBarrier();
	for(var j=bounds[0]+lane;j<bounds[1];j+=64u){
		let id=ids[j];var lo=x0;var hi=end+v.size-1u;
		while(lo+1u<hi){let mid=(lo+hi)/2u;if(spans[mid]<=id){lo=mid;}else{hi=mid;}}
		let left=i32(lo-x0)-i32(v.size-1u);
		let top=bitcast<i32>(data[id*2u])-i32(v.size/2u)-i32(y0);
		for(var y=max(top,0);y<min(top+i32(v.size),16);y++){
			for(var x=max(left,0);x<min(left+i32(v.size),16);x++){atomicMax(&tiles[u32(y*16+x)],id+1u);}
		}
	}
	workgroupBarrier();
	for(var i=lane;i<256u;i+=64u){
		let x=x0+(i&15u);let y=y0+(i>>4u);
		if(x<end && y<v.height){let last=atomicLoad(&tiles[i]);
			var c=vec4f(0);if(last!=0u){c=color(data[(last-1u)*2u+1u]);}
			textureStore(image,vec2u(y,x),c);
		}
	}
}`;
