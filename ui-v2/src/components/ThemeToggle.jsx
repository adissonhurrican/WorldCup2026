import { IconSun, IconMoon } from "./icons";

// Controlled by App (single source of truth for theme).
export default function ThemeToggle({ dark, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid h-9 w-9 place-items-center rounded-full text-ink active:opacity-50"
    >
      {dark ? <IconSun className="h-[22px] w-[22px]" /> : <IconMoon className="h-[22px] w-[22px]" />}
    </button>
  );
}
