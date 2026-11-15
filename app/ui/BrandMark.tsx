// The PraiseLoop mark: a clockwise loop wrapping a five-point star. Inline rather
// than an <img> so the app shell pays no extra request for it. The artwork mirrors
// assets/brand/praiseloop-mark-reverse.svg, the version drawn for green surfaces;
// keep the two in step when the logo changes.
export default function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M82.68 45.41A33 33 0 1 1 66.5 21.42" fill="none" stroke="#F7F4EA" strokeWidth="9" strokeLinecap="round" />
      <path d="M61.5 30.08 79.06 28.67 71.5 12.76Z" fill="#F7F4EA" stroke="#F7F4EA" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M50 32.7 54.47 45.05 67.59 45.48 57.23 53.55 60.87 66.17 50 58.8 39.13 66.17 42.77 53.55 32.41 45.48 45.53 45.05Z" fill="#F4B731" stroke="#F4B731" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
