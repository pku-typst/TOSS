export function BrandMark({
  mark,
  label,
  slot,
  className = ""
}: {
  mark: string;
  label: string;
  slot?: string;
  className?: string;
}) {
  return (
    <span slot={slot} className={`brand-mark ${className}`.trim()} role="img" aria-label={label}>
      {mark}
    </span>
  );
}
