const OPERATIONS = new Set(['models','list','create','get','send','stop','delete']);
function trusted(req) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  const {host,origin}=req.headers;
  if(typeof host!=='string' || typeof origin!=='string' || req.headers['sec-fetch-site']==='cross-site') return false;
  try {
    const target=new URL(`http://${host}`);
    const source=new URL(origin);
    return ['127.0.0.1','localhost','[::1]'].includes(target.hostname)
      && source.protocol===(req.socket.encrypted ? 'https:' : 'http:') && source.host===target.host
      && source.origin===origin;
  } catch { return false; }
}
function respond(res,status,value) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
/** Loopback-only browser endpoint; trust fence is not remote authentication. */
export function createHandler(service) {
  return async(req,res)=>{
    if(req.method!=='POST') return respond(res,405,{ok:false,error:'POST required'});
    if(!trusted(req)) return respond(res,403,{ok:false,error:'Same-origin loopback request required'});
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) return respond(res,415,{ok:false,error:'JSON required'});
    const chunks=[]; let bytes=0;
    try {
      for await(const chunk of req) {
        const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        bytes+=buffer.length;
        if(bytes>96000) return respond(res,413,{ok:false,error:'Request too large'});
        chunks.push(buffer);
      }
      const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!payload || typeof payload!=='object' || Array.isArray(payload) || !OPERATIONS.has(payload.action)) throw new Error('Unknown Side Chat operation');
      const value=await service[payload.action](payload);
      respond(res,200,{ok:true,value});
    } catch(error) { respond(res,400,{ok:false,error:String(error?.message??error).slice(0,2000)}); }
  };
}
