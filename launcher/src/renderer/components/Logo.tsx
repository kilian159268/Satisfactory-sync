/** V3in-Logo: Sechseck und linker Strich orange, rechter Strich hell (DESIGN.md). */
export function Logo() {
  return (
    <svg
      className="logo"
      width="24"
      height="24"
      viewBox="0 0 800 800"
      role="img"
      aria-label="V3in-Logo"
    >
      <polygon
        className="logo__hex"
        points="400,31 721,216 721,584 400,769 79,584 79,216"
        fill="none"
        strokeWidth="34"
        strokeLinejoin="miter"
      />
      <polygon className="logo__left" points="178,238 258,238 400,478 400,612" />
      <polygon className="logo__right" points="545,238 625,238 400,612 400,478" />
    </svg>
  );
}
