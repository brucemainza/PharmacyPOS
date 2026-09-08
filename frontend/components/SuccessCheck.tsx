// A self-contained animated checkmark (circle draws in, then the check strokes in) — pure SVG +
// CSS keyframes, no animation library needed. Re-plays every time it mounts, since the parent
// only renders this when a payment has actually just succeeded.
export default function SuccessCheck({ size = 84 }: { size?: number }) {
  return (
    <svg
      className="success-check"
      width={size}
      height={size}
      viewBox="0 0 84 84"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle className="success-check-bg" cx="42" cy="42" r="38" />
      <circle className="success-check-circle" cx="42" cy="42" r="38" />
      <path className="success-check-mark" d="M24 43 L36 55 L60 29" />
    </svg>
  );
}
