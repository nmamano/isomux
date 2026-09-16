import { chromium } from 'playwright-core';
const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
function size(data:string){const b=Buffer.from(data,'base64');let i=2;while(i<b.length){if(b[i++]!==255)continue;const t=b[i++];if([192,193,194].includes(t))return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];i+=b.readUInt16BE(i);}return [];}
try {for(const mode of ['dpr','visible','scale-visible','viewport']) {
 const context=await browser.newContext({viewport:{width:400,height:680},deviceScaleFactor:2}); const page=await context.newPage();
 await page.setContent('<style>body{margin:0;height:2000px}button{position:absolute;left:300px;top:500px;width:70px;height:40px}</style><button id="far" onclick="this.dataset.clicked=String(Number(this.dataset.clicked||0)+1)">far</button>');
 const cdp=await context.newCDPSession(page);const frames:any[]=[];
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:680,deviceScaleFactor:2,mobile:false,...(mode==='scale-visible'?{scale:2}:{}),...(mode==='viewport'?{viewport:{x:0,y:0,width:400,height:680,scale:2}}:{})});
 if(mode.includes('visible'))await cdp.send('Emulation.setVisibleSize',{width:800,height:1360});
 cdp.on('Page.screencastFrame',e=>{frames.push({size:size(e.data),metadata:e.metadata});void Bun.write('prototypes/browser-panel-measure/evidence/probe-'+mode+'.jpg',Buffer.from(e.data,'base64'));void cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});
 await cdp.send('Page.startScreencast',{format:'jpeg',maxWidth:800,maxHeight:1360,everyNthFrame:1});
 let click='ok';try{await page.locator('#far').click({timeout:1500});}catch{click='fail';}
 await page.mouse.click(330,520); await Bun.sleep(100);
 const start=await page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,clicks:document.querySelector('button')?.getAttribute('data-clicked')}));
 await page.evaluate(()=>scrollTo(0,300));await Bun.sleep(100);
 console.log(JSON.stringify({mode,click,start,frames:frames.slice(-2),scroll:await page.evaluate(()=>scrollY)}));
 await context.close();
}}finally{await browser.close();}
