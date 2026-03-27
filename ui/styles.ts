export const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0e16; overflow:hidden; }
  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.06); border-radius:3px; }

  @keyframes waitBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
  @keyframes errShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-2px)} 75%{transform:translateX(2px)} }
  @keyframes dotPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.5)} }
  @keyframes termEnter { from{opacity:0} to{opacity:1} }
  @keyframes hudIn { from{opacity:0;transform:translateY(4px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
  @keyframes toastSlide { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
`;
