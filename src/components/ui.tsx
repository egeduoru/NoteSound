import { useEffect, useRef, type ReactNode } from "react";
import { X, Music2, LoaderCircle } from "lucide-react";
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        {[15, 27, 38, 27, 15].map((h, i) => (
          <i key={i} style={{ height: h }} />
        ))}
      </span>
      {!compact && (
        <span>
          NoteSound<small>МУЗЫКА В ТВОЁМ РИТМЕ</small>
        </span>
      )}
    </div>
  );
}
export function Cover({
  src,
  title,
  className = "",
}: {
  src?: string;
  title: string;
  className?: string;
}) {
  return (
    <div className={`cover ${className}`}>
      {src ? (
        <img
          src={src}
          alt={title}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <Music2 />
      )}
      <span className="cover-fallback" aria-hidden="true">
        <Music2 />
      </span>
    </div>
  );
}
export function Equalizer() {
  return (
    <span className="equalizer" aria-label="Играет">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} />
      ))}
    </span>
  );
}
export function Empty({
  icon,
  children,
  action,
}: {
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || <Music2 size={30} />}</div>
      <div>{children}</div>
      {action}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={20} />;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        const all = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,a[href],[tabindex="0"]',
          ),
        );
        const first = all[0],
          last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      window.removeEventListener("keydown", key);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal glass ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export const formatTime = (seconds: number) => {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
