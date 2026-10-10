import { afterAll, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const {render,fireEvent,act}=await import("@testing-library/react");
const {WidgetChat,AppWidgetPage}=await import("./AppWidgetPage.tsx");
const {beginAppHandshake}=await import("./app-widget-state.ts");
const {setApiShim}=await import("./api.ts");
const {en}=await import("../shared/i18n/en.ts");
afterAll(()=>setApiShim(null));

const boot={name:"hello",registration:1};
const agent={id:"one",name:"One",state:"idle",queue:[]} as unknown as import("../shared/types.ts").AgentInfo;
const props={boot,agent,logs:[],connected:true,open:true,onRecheck:()=>{}};

for (const [platform, hint] of [["Win32", "appWidget.windowsHint"], ["MacIntel", "appWidget.macHint"]] as const) {
  it(`renders the screenshot shortcut for ${platform}`, () => {
    sessionStorage.clear();
    const values = {platform, userAgent: "Mozilla/5.0", maxTouchPoints: 0};
    const descriptors = Object.getOwnPropertyDescriptors(navigator);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(navigator, key, {configurable: true, value});
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<WidgetChat {...props}/>);
      expect(view.container.querySelector(".app-widget-hint")?.textContent).toBe(en[hint]);
    } finally {
      view?.unmount();
      for (const key of Object.keys(values)) {
        if (descriptors[key]) Object.defineProperty(navigator, key, descriptors[key]);
        else Reflect.deleteProperty(navigator, key);
      }
    }
  });
}

it("keeps a failed draft and retry id across remount, and separates a changed target",async()=>{
  sessionStorage.clear();
  const posts: {text:string;clientMessageId:string;appContext:unknown}[]=[];
  let fail=true;
  setApiShim(async(method,path,body)=>{
    expect(method).toBe("POST"); expect(path).toBe("/api/agents/one/messages");
    posts.push(body as typeof posts[number]);
    if(fail)throw new Error("offline");
    return {};
  });
  let view=render(<WidgetChat {...props}/>);
  await act(async()=>{fireEvent.change(view.getByRole("textbox"),{target:{value:"original draft"}});});
  await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("original draft");
  expect(posts[0].appContext).toEqual(boot);
  view.unmount();
  view=render(<WidgetChat {...props}/>);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("original draft");
  fail=false;
  await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
  expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  await act(async()=>{fireEvent.change(view.getByRole("textbox"),{target:{value:"only for one"}});});
  view.rerender(<WidgetChat {...props} agent={{...agent,id:"two"}}/>);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
  expect(posts).toHaveLength(2);
  view.unmount();
});

it("does not send while the reply connection is offline",async()=>{
  sessionStorage.clear();
  let sends=0;
  setApiShim(async()=>{sends++;return {};});
  const view=render(<WidgetChat {...props} connected={false}/>);
  await act(async()=>{fireEvent.change(view.getByRole("textbox"),{target:{value:"wait for reconnect"}});fireEvent.submit(view.container.querySelector("form")!);});
  expect(sends).toBe(0);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("wait for reconnect");
});

for (const serverLive of [false, true]) {
  it(`latches failed recovery across later refreshes (server live: ${serverLive})`, async () => {
    sessionStorage.clear();
    const settings = (window as unknown as {happyDOM: {settings: {disableIframePageLoading: boolean}}}).happyDOM.settings;
    const iframeLoading = settings.disableIframePageLoading;
    settings.disableIframePageLoading = true;
    let now = 100000;
    const date = spyOn(Date, "now").mockImplementation(() => now);
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    beginAppHandshake(sessionStorage, boot, now);
    const appUrl = "https://hello.office.example";
    setApiShim(async () => ({ ...boot, appUrl, sessionExpiresAt: serverLive ? now + 1000000 : null, chat: null }));
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<AppWidgetPage boot={boot}/>); });
      if (serverLive) {
        const frame = view!.container.querySelector("iframe")!;
        expect(frame).not.toBeNull();
        // No remote iframe loads in the DOM test; supply its window identity.
        const frameWindow = {} as Window;
        Object.defineProperty(frame, "contentWindow", { value: frameWindow });
        await act(async () => {
          window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: appUrl, data: "isomux:app-session-required" }));
        });
      }
      expect(view!.container.querySelector(".app-widget-unavailable")).not.toBeNull();
      now += 61000;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(assign).not.toHaveBeenCalled();
      expect(view!.container.querySelector(".app-widget-unavailable")).not.toBeNull();
      expect(view!.container.querySelector("iframe")).toBeNull();
    } finally {
      view?.unmount(); assign.mockRestore(); date.mockRestore();
      settings.disableIframePageLoading = iframeLoading;
    }
  });
}

const imageAttachment = { filename:"image.png", originalName:"shot.png", mediaType:"image/png", size:3 };
const imageFile = () => new File(["png"],"shot.png",{type:"image/png"});

it("uploads file selection, preserves image retries, and rotates ids for changed image sets", async () => {
  sessionStorage.clear();
  const uploads = spyOn(globalThis,"fetch").mockImplementation((async (url,init) => {
    expect(url).toBe("/api/upload/one"); expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    return new Response(JSON.stringify({attachments:[imageAttachment]}));
  }) as typeof fetch);
  const posts: {attachments:unknown[];clientMessageId:string}[]=[];
  setApiShim(async (_method,_path,body) => {posts.push(body as typeof posts[number]);throw new Error("send failed");});
  let view=render(<WidgetChat {...props}/>);
  try {
    await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[imageFile()]}});});
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(view.container.querySelectorAll(".app-widget-image img")).toHaveLength(1);
    await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
    expect(posts[0].attachments).toEqual([imageAttachment]);
    view.unmount(); view=render(<WidgetChat {...props}/>);
    expect(view.container.querySelectorAll(".app-widget-image img")).toHaveLength(1);
    await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
    expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
    await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[imageFile()]}});});
    await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
    expect(posts[2].clientMessageId).not.toBe(posts[1].clientMessageId);
    expect(posts[2].attachments).toHaveLength(2);
    await act(async()=>{fireEvent.click(view.container.querySelector(".app-widget-image button")!);});
    await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
    expect(posts[3].clientMessageId).not.toBe(posts[2].clientMessageId);
    expect(posts[3].attachments).toHaveLength(1);
  } finally {view.unmount();uploads.mockRestore();}
});

it("uploads image paste and drop, and leaves text paste and other files alone", async () => {
  sessionStorage.clear();
  const uploads=spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({attachments:[imageAttachment]})));
  const view=render(<WidgetChat {...props}/>);
  try {
    const target=view.container.querySelector(".app-widget-chat-content")!;
    const textPaste=new Event("paste",{bubbles:true,cancelable:true});
    Object.defineProperty(textPaste,"clipboardData",{value:{items:[{kind:"string",type:"text/plain"}]}});
    await act(async()=>{fireEvent(target,textPaste);});
    expect(textPaste.defaultPrevented).toBe(false);
    expect(uploads).not.toHaveBeenCalled();
    await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[new File(["txt"],"note.txt",{type:"text/plain"})]}});});
    expect(uploads).not.toHaveBeenCalled();
    await act(async()=>{fireEvent.paste(target,{clipboardData:{items:[{kind:"file",type:"image/png",getAsFile:imageFile}]}});});
    expect(uploads).toHaveBeenCalledTimes(1);
    uploads.mockResolvedValue(new Response(JSON.stringify({attachments:[imageAttachment]})));
    await act(async()=>{fireEvent.drop(target,{dataTransfer:{files:[imageFile()]}});});
    expect(uploads).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll(".app-widget-image img")).toHaveLength(2);
  } finally {view.unmount();uploads.mockRestore();}
});

for(const change of ["remove","target"] as const) {
  it(`ignores an upload completion after ${change}`, async()=>{
    sessionStorage.clear();
    let finish!:(response:Response)=>void;
    const uploads=spyOn(globalThis,"fetch").mockImplementation(Object.assign(()=>new Promise<Response>(resolve=>{finish=resolve;}),{preconnect:()=>{}}));
    let sends=0;setApiShim(async()=>{sends++;return {};});
    const view=render(<WidgetChat {...props}/>);
    try {
      await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[imageFile()]}});});
      expect(uploads.mock.calls[0][0]).toBe("/api/upload/one");
      await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
      expect(sends).toBe(0);
      if(change==="remove") await act(async()=>{fireEvent.click(view.container.querySelector(".app-widget-image button")!);});
      else view.rerender(<WidgetChat {...props} agent={{...agent,id:"two"}}/>);
      await act(async()=>{finish(new Response(JSON.stringify({attachments:[imageAttachment]})));});
      expect(view.container.querySelectorAll(".app-widget-image")).toHaveLength(0);
      await act(async()=>{fireEvent.submit(view.container.querySelector("form")!);});
      expect(sends).toBe(0);
      await act(async()=>{fireEvent.change(view.getByRole("textbox"),{target:{value:"fresh text"}});fireEvent.submit(view.container.querySelector("form")!);});
      expect(sends).toBe(1);
    } finally {view.unmount();uploads.mockRestore();}
  });
}

it("keeps oversize and failed images removable without sending them", async()=>{
  sessionStorage.clear();
  const uploads=spyOn(globalThis,"fetch").mockResolvedValue(new Response("failed",{status:500}));
  const view=render(<WidgetChat {...props}/>);
  try {
    const tooLarge=imageFile();Object.defineProperty(tooLarge,"size",{value:201*1024*1024});
    await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[tooLarge]}});});
    expect(uploads).not.toHaveBeenCalled();
    expect(view.container.querySelector(".app-widget-image [role=status]")).not.toBeNull();
    await act(async()=>{fireEvent.click(view.container.querySelector(".app-widget-image button")!);});
    await act(async()=>{fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[imageFile()]}});});
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".app-widget-image [role=status]")).not.toBeNull();
    expect((view.container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async()=>{fireEvent.click(view.container.querySelector(".app-widget-image button")!);});
    expect(view.container.querySelectorAll(".app-widget-image")).toHaveLength(0);
  } finally {view.unmount();uploads.mockRestore();}
});
