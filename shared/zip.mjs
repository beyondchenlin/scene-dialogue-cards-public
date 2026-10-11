/** Bounded ZIP32 reader/writer: stored (0) and deflate (8), CRC verification, no external dependencies. */
import { LIMITS, safePath } from './pack.mjs';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const TABLE = Uint32Array.from({length:256}, (_, n) => { for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0; });
export function crc32(bytes) { let crc=0xffffffff;for(const b of bytes)crc=TABLE[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0; }
function directory(input) {
  const b=input instanceof Uint8Array?input:new Uint8Array(input); if(b.length>LIMITS.totalBytes)throw new Error('ZIP 超过 384 MiB 限制。');
  const d=new DataView(b.buffer,b.byteOffset,b.byteLength);let end=-1;
  for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--)if(d.getUint32(p,true)===0x06054b50&&p+22+d.getUint16(p+20,true)===b.length){end=p;break;}
  if(end<0)throw new Error('ZIP 尾目录不存在或损坏。');
  if(d.getUint16(end+4,true)||d.getUint16(end+6,true))throw new Error('不支持分卷 ZIP。');
  const count=d.getUint16(end+10,true),size=d.getUint32(end+12,true),start=d.getUint32(end+16,true);
  if(count!==d.getUint16(end+8,true)||count>LIMITS.files||count===65535||size===0xffffffff||start===0xffffffff||start+size!==end)throw new Error('ZIP 目录超限、ZIP64 或目录偏移无效。');
  const entries=[],names=new Set();let p=start,total=0;
  for(let n=0;n<count;n++){
    if(p+46>end||d.getUint32(p,true)!==0x02014b50)throw new Error('ZIP 目录记录无效。');
    const flags=d.getUint16(p+8,true),method=d.getUint16(p+10,true),crc=d.getUint32(p+16,true),compressed=d.getUint32(p+20,true),uncompressed=d.getUint32(p+24,true),nl=d.getUint16(p+28,true),el=d.getUint16(p+30,true),cl=d.getUint16(p+32,true),offset=d.getUint32(p+42,true),external=d.getUint32(p+38,true);
    if(p+46+nl+el+cl>end||flags&1||![0,8].includes(method))throw new Error('ZIP 加密、压缩方式或文件名无效（仅支持存储和 Deflate）。');
    const name=decoder.decode(b.subarray(p+46,p+46+nl));p+=46+nl+el+cl;
    if((external>>>16&0xf000)===0xa000)throw new Error('ZIP 不允许符号链接。');
    const path=safePath(name.endsWith('/')?name.slice(0,-1):name);
    if(names.has(path.toLowerCase()))throw new Error(`ZIP 路径重复：${path}`);names.add(path.toLowerCase());
    if(uncompressed>LIMITS.fileBytes||compressed>LIMITS.fileBytes||(total+=uncompressed)>LIMITS.totalBytes||(uncompressed>1024*1024&&uncompressed/Math.max(1,compressed)>200))throw new Error('ZIP 解压大小或压缩率超限。');
    if(offset+30>start||d.getUint32(offset,true)!==0x04034b50)throw new Error('ZIP 本地文件头无效。');
    const localFlags=d.getUint16(offset+6,true),localMethod=d.getUint16(offset+8,true),ln=d.getUint16(offset+26,true),le=d.getUint16(offset+28,true),dataStart=offset+30+ln+le;
    if(dataStart+compressed>start||localFlags!==flags||localMethod!==method||decoder.decode(b.subarray(offset+30,offset+30+ln))!==name)throw new Error('ZIP 本地和目录记录不一致。');
    if(!(flags&8)&&(d.getUint32(offset+14,true)!==crc||d.getUint32(offset+18,true)!==compressed||d.getUint32(offset+22,true)!==uncompressed))throw new Error('ZIP 本地尺寸或校验和不一致。');
    if(name.endsWith('/')){if(uncompressed||compressed)throw new Error('ZIP 目录包含内容。');continue;}
    entries.push({path,method,crc,compressed,uncompressed,offset,dataStart,end:dataStart+compressed,bytes:b.subarray(dataStart,dataStart+compressed)});
  }
  if(p!==end)throw new Error('ZIP 目录大小不一致。');
  const ranges=[...entries].sort((a,b)=>a.offset-b.offset);for(let i=1;i<ranges.length;i++)if(ranges[i].offset<ranges[i-1].end)throw new Error('ZIP 文件数据重叠。');
  return entries;
}
async function browserInflate(bytes, limit) {
  let stream;try{stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));}catch{throw new Error('此浏览器不支持 Deflate ZIP 解压。请先解压后导入文件夹，或使用本地 CLI。');}
  const reader=stream.getReader(),parts=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw new Error('ZIP 实际解压大小超过声明。');}parts.push(value);}}finally{reader.releaseLock();}
  const out=new Uint8Array(total);let p=0;for(const part of parts){out.set(part,p);p+=part.length;}return out;
}
export async function readZip(input, {inflate=browserInflate}={}) {
  const entries=directory(input),out=[];
  for(const e of entries){const bytes=e.method===0?e.bytes.slice():await inflate(e.bytes,e.uncompressed);if(bytes.length!==e.uncompressed||crc32(bytes)!==e.crc)throw new Error(`ZIP 大小或 CRC 校验失败：${e.path}`);out.push({path:e.path,bytes});}
  return out;
}
export function writeZip(entries) {
  if(entries.length>LIMITS.files)throw new Error('导出文件数量超限。');
  const local=[],central=[],names=new Set();let offset=0,total=0;
  for(const {path:raw,bytes:input} of entries){
    const path=safePath(raw),name=encoder.encode(path),bytes=input instanceof Uint8Array?input:new Uint8Array(input);
    if(names.has(path.toLowerCase()))throw new Error(`导出文件重复：${path}`);names.add(path.toLowerCase());
    if(bytes.length>LIMITS.fileBytes||(total+=bytes.length)>LIMITS.totalBytes)throw new Error('导出文件大小超限。');
    const crc=crc32(bytes),head=new Uint8Array(30+name.length),d=new DataView(head.buffer);
    d.setUint32(0,0x04034b50,true);d.setUint16(4,20,true);d.setUint16(6,0x800,true);d.setUint16(12,33,true);d.setUint32(14,crc,true);d.setUint32(18,bytes.length,true);d.setUint32(22,bytes.length,true);d.setUint16(26,name.length,true);head.set(name,30);local.push(head,bytes);
    const c=new Uint8Array(46+name.length),v=new DataView(c.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,bytes.length,true);v.setUint32(24,bytes.length,true);v.setUint16(28,name.length,true);v.setUint32(42,offset,true);c.set(name,46);central.push(c);offset+=head.length+bytes.length;
  }
  const centralSize=central.reduce((n,a)=>n+a.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);
  const out=new Uint8Array(offset+centralSize+22);let pos=0;for(const part of [...local,...central,end]){out.set(part,pos);pos+=part.length;}return out;
}
