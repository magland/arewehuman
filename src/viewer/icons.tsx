// Icons for the replay controls.
const svg = (size: number) => ({ width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true });
export const PlayIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...svg(size)}>
    <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" />
  </svg>
);
export const PauseIcon = () => (
  <svg {...svg(16)}>
    <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
    <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
  </svg>
);
export const AgainIcon = () => (
  <svg {...svg(16)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8" />
    <path d="M2.8 1.8v3h3" />
  </svg>
);
