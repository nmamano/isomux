import { BrowserPool } from '../../server/browser-session.ts';
import { mkdtempSync } from 'node:fs';
const pool=new BrowserPool({stateRoot:mkdtempSync('prototypes/browser-panel-measure/evidence/state-')});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<body>Quiet viewport</body>',{headers:{'Content-Type':'text/html'}})});
let low=()=>{},high=()=>{};
function width(data:string){const b=Buffer.from(data,'base64');let i=2;while(i<b.length){if(b[i++]!==255)continue;const t=b[i++];if([192,193,194].includes(t))return b.readUInt16BE(i+5);i+=b.readUInt16BE(i);}throw Error('jpeg');}
try{
 await pool.run('a',{action:'goto',url:`http://127.0.0.1:${server.port}`,viewport:{width:400,height:680}});
 let since=0,expected=400,first:number|undefined;
 const listener=(f:{data:string}|null)=>{if(f && first===undefined && width(f.data)===expected)first=performance.now()-since;};
 async function wait(){const deadline=performance.now()+3000;while(first===undefined){if(performance.now()>deadline)throw Error('missing frame');await Bun.sleep(5);}}
 const start=(target:number)=>{expected=target;first=undefined;since=performance.now();};
 start(400);low=pool.watch('a',listener,()=>true,{deviceScaleFactor:1});await wait();
 for(const action of ['join2','resize2','leave2']){
  start(action==='join2'?800:action==='resize2'?820:410);
  if(action==='join2')high=pool.watch('a',f=>listener(f),()=>true,{deviceScaleFactor:2});
  else if(action==='resize2')await pool.humanInput('a',{kind:'viewport',width:410,height:690});
  else high();
  await wait();
  const session=(pool as any).sessions.get('a');
  console.log(JSON.stringify({date:new Date().toISOString(),action,firstFrameMs:first,physicalWidth:expected,page:await session.page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))}));
 }
 low();await Bun.sleep(50);const session=(pool as any).sessions.get('a');console.log('lastLeaves',JSON.stringify({dpr:await session.page.evaluate(()=>devicePixelRatio),capture:!!session.screencast}));
}finally{low();high();await pool.shutdown();server.stop(true);}
