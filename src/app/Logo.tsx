export function Logo({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="MC Bot Manager logo"
    >
      <defs>
        <linearGradient id="logoBg" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
        <linearGradient id="logoFace" x1="10" y1="12" x2="38" y2="38">
          <stop offset="0" stopColor="#ecfdf5" />
          <stop offset="1" stopColor="#a7f3d0" />
        </linearGradient>
      </defs>
      {/* rounded square base */}
      <rect width="48" height="48" rx="13" fill="url(#logoBg)" />
      <rect
        width="48"
        height="48"
        rx="13"
        fill="url(#logoBg)"
        opacity="0.4"
      />
      {/* antenna */}
      <circle cx="24" cy="9" r="2.4" fill="#ecfdf5" />
      <rect x="23" y="10.5" width="2" height="4" rx="1" fill="#ecfdf5" />
      {/* robot head */}
      <rect
        x="11"
        y="14"
        width="26"
        height="21"
        rx="6"
        fill="url(#logoFace)"
      />
      {/* eyes */}
      <rect x="16.5" y="21" width="5" height="6.5" rx="2.5" fill="#0f766e" />
      <rect x="26.5" y="21" width="5" height="6.5" rx="2.5" fill="#0f766e" />
      {/* eye glints */}
      <circle cx="19" cy="23" r="1" fill="#a7f3d0" />
      <circle cx="29" cy="23" r="1" fill="#a7f3d0" />
      {/* mouth / status bar */}
      <rect x="18" y="30.5" width="12" height="2" rx="1" fill="#0f766e" opacity="0.55" />
      {/* side ears */}
      <rect x="8.5" y="22" width="3" height="6" rx="1.5" fill="#ecfdf5" />
      <rect x="36.5" y="22" width="3" height="6" rx="1.5" fill="#ecfdf5" />
    </svg>
  );
}
