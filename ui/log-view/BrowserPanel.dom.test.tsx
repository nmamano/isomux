import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { setShim, shimEmit } = await import("../ws.ts");
const { BrowserPanel, useBrowserAutoOpen } = await import("./BrowserPanel.tsx");
import type { ClientCommand } from "../../shared/types.ts";

afterAll(() =>
  setShim(
    () => {},
    () => {},
  ),
);

describe("BrowserPanel", () => {
  it("subscribes, paints frames, and forwards pointer and keyboard input", () => {
    const sent: ClientCommand[] = [];
    setShim(
      (command) => sent.push(command),
      () => {},
    );
    const view = render(<BrowserPanel agentId="agent-1" canDrive onClose={() => {}} />);
    expect(sent[0]).toEqual({
      type: "browser_watch",
      agentId: "agent-1",
      watching: true,
    });
    expect(
      view.getAllByText("Loading…").length > 0,
    ).toBe(true);

    act(() => {
      shimEmit({
        type: "browser_frame",
        agentId: "agent-1",
        data: "jpeg",
        width: 800,
        height: 600,
      });
    });
    const surface = view.getByRole("application");
    Object.defineProperty(surface, "getBoundingClientRect", {
      value: () => ({
        left: 10,
        top: 20,
        width: 400,
        height: 300,
        right: 410,
        bottom: 320,
        x: 10,
        y: 20,
        toJSON() {},
      }),
    });
    fireEvent.mouseDown(surface, { clientX: 210, clientY: 170 });
    fireEvent.keyDown(surface, { key: "a", code: "KeyA" });

    expect(
      sent.some(
        (command) =>
          command.type === "browser_input" &&
          command.input.kind === "mouse" &&
          command.input.x === 400 &&
          command.input.y === 300,
      ),
    ).toBe(true);
    expect(
      sent.some(
        (command) =>
          command.type === "browser_input" &&
          command.input.kind === "key" &&
          command.input.text === "a",
      ),
    ).toBe(true);
    view.unmount();
    expect(sent.at(-1)).toEqual({
      type: "browser_watch",
      agentId: "agent-1",
      watching: false,
    });
  });
  it("drops pending stale frames and draws at decoded size with page coordinates", () => {
    const OriginalImage = globalThis.Image;
    const images: Array<{src:string;naturalWidth:number;naturalHeight:number;onload:(() => void) | null;onerror:(() => void) | null}> = [];
    globalThis.Image = class {
      src=""; naturalWidth=400; naturalHeight=250; onload=null; onerror=null;
      constructor() { images.push(this); }
    } as unknown as typeof Image;
    const sent: ClientCommand[]=[];
    setShim(command => sent.push(command));
    const view = render(<BrowserPanel agentId="decode" canDrive onClose={() => {}} />);
    const frame = (data:string) => act(() => shimEmit({type:"browser_frame",agentId:"decode",data,width:1280,height:800}));
    try {
      frame("first"); frame("old"); frame("latest");
      expect(images).toHaveLength(1);
      act(() => images[0].onload?.());
      expect(images).toHaveLength(2);
      expect(images[1].src).toBe("data:image/jpeg;base64,latest");
      const canvas = view.getByRole("application") as HTMLCanvasElement;
      expect([canvas.width,canvas.height]).toEqual([400,250]);
      Object.defineProperty(canvas,"getBoundingClientRect",{value:()=>({left:0,top:0,width:400,height:250})});
      fireEvent.mouseDown(canvas,{clientX:200,clientY:125});
      expect(sent).toContainEqual({type:"browser_input",agentId:"decode",input:{kind:"mouse",event:"mousePressed",x:640,y:400,button:"left",clickCount:1}});
      act(() => shimEmit({type:"browser_status",agentId:"decode",available:false}));
      act(() => images[1].onload?.());
      expect(canvas.style.display).toBe("none");
    } finally { view.unmount(); globalThis.Image=OriginalImage; }
  });

  it("requests device pixels and debounces quantized capture bounds", async () => {
    const sent: ClientCommand[] = [];
    setShim(command => sent.push(command));
    const originalObserver = globalThis.ResizeObserver;
    const originalRatio = window.devicePixelRatio;
    let resize: ResizeObserverCallback = () => {};
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {} unobserve() {} disconnect() {}
    };
    Object.defineProperty(window, "devicePixelRatio", {value:2, configurable:true});
    const view = render(<BrowserPanel agentId="retina" onClose={() => {}} />);
    const emit = (width:number) => resize([{contentRect:{width,height:240}} as ResizeObserverEntry], {} as ResizeObserver);
    try {
      act(() => { emit(390); emit(400); });
      expect(sent.filter(m => m.type === "browser_watch")).toHaveLength(1);
      await act(async () => { await new Promise(resolve => setTimeout(resolve,170)); });
      expect(sent.at(-1)).toEqual({type:"browser_watch",agentId:"retina",watching:true,maxWidth:800,maxHeight:480});
      const count = sent.length;
      act(() => emit(399));
      await act(async () => { await new Promise(resolve => setTimeout(resolve,170)); });
      expect(sent.length).toBe(count);
    } finally {
      view.unmount();
      globalThis.ResizeObserver = originalObserver;
      Object.defineProperty(window, "devicePixelRatio", {value:originalRatio, configurable:true});
    }
  });

  it("opens a page for the manager and sends navigation and close through input", () => {
    const sent: ClientCommand[] = [];
    setShim(command => sent.push(command));
    const view = render(<BrowserPanel agentId="nav" canDrive onClose={() => {}} />);
    const commands = () => sent.filter(m => m.type === "browser_input").map(m => m.input);
    expect(commands()).toContainEqual({kind:"navigate",action:"open"});
    const ready = () => act(() => shimEmit({type:"browser_status",agentId:"nav",available:true,url:"https://example.test",title:"Example",busy:false}));
    ready();
    fireEvent.change(view.getByRole("textbox",{name:"Address"}), {target:{value:"example.test/next"}});
    fireEvent.submit(view.getByRole("textbox",{name:"Address"}).closest("form")!);
    expect(commands()).toContainEqual({kind:"navigate",action:"goto",url:"https://example.test/next"});
    for (const [name, action] of [["Back","back"],["Forward","forward"],["Reload","reload"],["Close page","close"]] as const) {
      ready();fireEvent.click(view.getByRole("button",{name}));
      expect(commands()).toContainEqual({kind:"navigate",action});
    }
    act(() => shimEmit({type:"browser_status",agentId:"nav",available:false,busy:false,url:"",title:""}));
    expect(view.getByText("No page is open.")).toBeTruthy();
    expect(commands().filter(m => m.kind === "navigate" && m.action === "open")).toHaveLength(1);
    view.unmount();
  });

  it("room viewers subscribe without opening or driving the page", () => {
    const sent: ClientCommand[]=[];
    setShim(command => sent.push(command));
    const view=render(<BrowserPanel agentId="view" onClose={()=>{}}/>);
    act(()=>shimEmit({type:"browser_frame",agentId:"view",data:"jpeg",width:800,height:600}));
    const canvas=view.getByRole("application");
    fireEvent.mouseDown(canvas,{clientX:10,clientY:10});
    fireEvent.keyDown(canvas,{key:"a"});
    fireEvent.keyUp(canvas,{key:"a"});
    fireEvent.wheel(canvas,{deltaY:20});
    expect(sent.filter(m=>m.type==="browser_input")).toEqual([]);
    expect(view.queryByRole("button",{name:"Close page"})).toBeNull();
    expect((view.getByRole("textbox",{name:"Address"}) as HTMLInputElement).readOnly).toBe(true);
    view.unmount();
  });

  it("auto-opens only the mounted manager chat", () => {
    let opened=0;
    const open=()=>opened++;
    function Chat({id,manager}:{id:string;manager:boolean}) {useBrowserAutoOpen(id,manager,open);return null;}
    const view=render(<Chat id="active" manager/>);
    act(()=>shimEmit({type:"browser_action",agentId:"background"}));
    expect(opened).toBe(0);
    act(()=>shimEmit({type:"browser_action",agentId:"active"}));
    expect(opened).toBe(1);
    view.rerender(<Chat id="active" manager={false}/>);
    act(()=>shimEmit({type:"browser_action",agentId:"active"}));
    expect(opened).toBe(1);
    view.unmount();
    act(()=>shimEmit({type:"browser_action",agentId:"active"}));
    expect(opened).toBe(1);
  });

});
