import { chromium } from 'playwright-core';
import { BrowserPool, launchOptions } from '../../server/browser-session';
import { mkdtempSync } from 'node:fs';
const dir='prototypes/browser-panel-measure/evidence/';
const pool=new BrowserPool({stateRoot:mkdtempSync(dir+'state-'),actionMs:2500});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<style>body{margin:0;height:3000px}button{position:absolute;left:280px;top:800px;width:100px;height:40px}#marker{position:fixed;left:0;top:0;width:100px;height:100px;background:black}</style><div id=marker></div><button onclick="window.hits++" onmouseenter="window.hovers++">target</button><script>window.hits=0;window.hovers=0</script>',{headers:{'Content-Type':'text/html'}})});
const browser=await chromium.launch(launchOptions('/usr/bin/google-chrome'));
const decode=await browser.newPage();
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('condition timeout');await Bun.sleep(5);}}
try{for(const dpr of [1.5,2]){
 await pool.run('agent',{action:'goto',url:`http://127.0.0.1:${server.port}`,viewport:{width:400,height:680}});
 const s=(pool as any).sessions.get('agent');const frames:any[]=[];
 const stop=pool.watch('agent',f=>{if(f)frames.push(f)},()=>true,{deviceScaleFactor:dpr});await until(()=>frames.length>0);
 await s.page.evaluate(()=>scrollTo(0,300));await Bun.sleep(100);
 const click=await pool.run('agent',{action:'click',selector:'button'});
 if(!click.ok)throw Error('agent selector click failed '+JSON.stringify(click));
 await s.page.mouse.move(20,200);await s.page.locator('button').hover({timeout:2000});
 if(await s.page.evaluate(()=>(window as any).hovers)<1)throw Error('agent hover missed');
 await s.page.mouse.click(330,520);
 if(await s.page.evaluate(()=>(window as any).hits)!==2)throw Error('CSS mouse click missed');
 const png=await pool.run('agent',{action:'screenshot'});if(!png.ok||!png.png)throw Error('agent screenshot');
 if(png.png.readUInt32BE(16)!==400||png.png.readUInt32BE(20)!==680)throw Error('agent screenshot is not CSS');
 const original=s.page.screenshot.bind(s.page);let started=false;
 let transient:any, afterScreenshot:any;
 s.page.screenshot=async(...args:any[])=>{transient=await s.page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio}));started=true;await Bun.sleep(30);const result=await original(...args);afterScreenshot=await s.page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio}));return result;};
 const shot=pool.run('agent',{action:'screenshot'});await until(()=>started);
 const input=(async()=>{await pool.humanInput('agent',{kind:'mouse',event:'mousePressed',x:330,y:520,button:'left',clickCount:1});await pool.humanInput('agent',{kind:'mouse',event:'mouseReleased',x:330,y:520,button:'left',clickCount:1});})();
 await Promise.all([shot,input]);s.page.screenshot=original;
 if(transient.w!==400||transient.h!==680||afterScreenshot.w!==400||afterScreenshot.h!==680)throw Error('screenshot transient layout '+JSON.stringify({transient,afterScreenshot}));
 if(await s.page.evaluate(()=>(window as any).hits)!==3)throw Error('screenshot-raced human click missed or duplicated');
 await s.page.evaluate(()=>document.getElementById('marker')!.style.background='white');await Bun.sleep(350);
 const white=await decode.evaluate(async(data)=>{const img=new Image();img.src='data:image/jpeg;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d')!;x.drawImage(img,0,0);return {pixel:x.getImageData(10,10,1,1).data[0],size:[img.width,img.height]};},frames.at(-1).data);
 if(white.pixel<240)throw Error('single page repaint was lost');
 if(white.size[0]!==400*dpr||white.size[1]!==680*dpr)throw Error('DPR frame dimensions');
 const cdp=s.screencast;let worlds=0;cdp.on('Runtime.executionContextCreated',(e:any)=>{if(e.context.name==='isomux-input-paint')worlds++;});await cdp.send('Runtime.enable');
 const before=frames.length;
 for(let i=0;i<100;i++){const n=frames.length;await pool.humanInput('agent',{kind:'key',event:'keyUp',key:'Shift'});await until(()=>frames.length>n);}
 console.log(JSON.stringify({date:new Date().toISOString(),dpr,afterScroll:300,agentClick:true,agentHover:true,pageMouse:true,racedHumanClick:true,transient,afterScreenshot,hits:await s.page.evaluate(()=>(window as any).hits),layout:await s.page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})),agentPng:[400,680],singlePageRepaint:white,stills:frames.length-before,isolatedWorlds:worlds,bytesPerFrame:Buffer.from(frames.at(-1).data,'base64').length}));
 stop();await pool.close('agent');
}}finally{await browser.close();await pool.shutdown();server.stop(true);}
