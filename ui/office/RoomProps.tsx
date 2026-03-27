export function RoomProps() {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* Potted plant (left side) */}
      <div style={{ position: "absolute", left: "7%", bottom: "18%", opacity: 0.8 }}>
        <svg width="40" height="60" viewBox="0 0 40 60" overflow="visible">
          <rect x="12" y="35" width="16" height="20" rx="3" fill="#5a4a35" />
          <ellipse cx="20" cy="35" rx="10" ry="4" fill="#6a5a45" />
          <path d="M20 35 Q10 15 16 5" stroke="#3a8a3a" fill="none" strokeWidth="2" />
          <path d="M20 35 Q28 18 32 8" stroke="#4a9a4a" fill="none" strokeWidth="1.8" />
          <path d="M20 35 Q15 20 22 10" stroke="#3a7a3a" fill="none" strokeWidth="1.5" />
          <ellipse cx="16" cy="5" rx="5" ry="4" fill="#3a8a3a" opacity="0.7" />
          <ellipse cx="32" cy="8" rx="4" ry="3" fill="#4a9a4a" opacity="0.7" />
          <ellipse cx="22" cy="10" rx="4" ry="3.5" fill="#3a7a3a" opacity="0.6" />
        </svg>
      </div>
      {/* Water cooler (right side) */}
      <div style={{ position: "absolute", right: "8%", top: "38%", opacity: 0.6 }}>
        <svg width="30" height="56" viewBox="0 0 30 56">
          <rect x="6" y="20" width="18" height="30" rx="2" fill="#2a3548" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
          <rect x="10" y="8" width="10" height="14" rx="2" fill="#3a5070" opacity="0.6" />
          <ellipse cx="15" cy="8" rx="6" ry="2" fill="#3a5070" opacity="0.5" />
          <circle cx="12" cy="38" r="2" fill="#4a90d9" opacity="0.4" />
          <circle cx="18" cy="38" r="2" fill="#e85d75" opacity="0.4" />
          <rect x="8" y="50" width="14" height="4" rx="1" fill="#222d3a" />
        </svg>
      </div>
    </div>
  );
}
