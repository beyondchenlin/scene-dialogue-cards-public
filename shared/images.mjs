import { crc32 } from './zip.mjs';
import { LIMITS } from './pack.mjs';
const ascii = (b, a, z) => String.fromCharCode(...b.subarray(a,z));
export function imageDimensions(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input), d = new DataView(b.buffer,b.byteOffset,b.byteLength);
  let width, height, type;
  if (b.length >= 33 && [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v) && ascii(b,12,16)==='IHDR') { width=d.getUint32(16); height=d.getUint32(20); type='image/png';let p=8,idat=false,ended=false;while(p+12<=b.length){const size=d.getUint32(p),kind=ascii(b,p+4,p+8);if(p+12+size>b.length||crc32(b.subarray(p+4,p+8+size))!==d.getUint32(p+8+size))throw new Error('PNG 文件损坏或校验和不符。');if(kind==='IDAT')idat=true;if(kind==='IEND'){if(size!==0)throw new Error('PNG 结束块无效。');ended=true;break;}p+=12+size;}if(!idat||!ended)throw new Error('PNG 缺少像素数据或结束块。'); }
  else if (b.length >= 12 && b[0]===255 && b[1]===216) {
    let p=2;
    while(p+4<=b.length) {
      if(b[p++]!==255) throw new Error('JPEG 段结构无效。');
      while(b[p]===255)p++;
      const marker=b[p++]; if(marker===217||marker===218)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(p+2>b.length)break; const size=d.getUint16(p); if(size<2||p+size>b.length)throw new Error('JPEG 文件被截断。');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(size<8)break;height=d.getUint16(p+3);width=d.getUint16(p+5);type='image/jpeg';break;} p+=size;
    }
  } else if(b.length>=30&&ascii(b,0,4)==='RIFF'&&ascii(b,8,12)==='WEBP') {
    const kind=ascii(b,12,16); type='image/webp';
    if(kind==='VP8X'){width=1+b[24]+(b[25]<<8)+(b[26]<<16);height=1+b[27]+(b[28]<<8)+(b[29]<<16);}
    else if(kind==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){width=d.getUint16(26,true)&16383;height=d.getUint16(28,true)&16383;}
    else if(kind==='VP8L'&&b[20]===47){const bits=d.getUint32(21,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
  }
  if(type==='image/jpeg'){let end=false;for(let i=b.length-2;i>=2;i--)if(b[i]===255&&b[i+1]===217){end=true;break;}if(!end)throw new Error('JPEG 文件缺少结束标记。');}
  if(!width||!height||width*height>LIMITS.imagePixels) throw new Error('图片格式／尺寸无效，或超过 5000 万像素。');
  return {width,height,type};
}
export async function inspectBlob(blob, {decode = false} = {}) {
  if(blob.size>LIMITS.fileBytes)throw new Error('单文件超过 64 MiB 限制。');
  const result=imageDimensions(await blob.arrayBuffer());
  if(decode){
    const bitmap=await createImageBitmap(blob);
    try {if(bitmap.width!==result.width||bitmap.height!==result.height)throw new Error('图片解码尺寸与文件头不一致。');} finally {bitmap.close();}
  }
  return result;
}
