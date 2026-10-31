import { useCallback, useState } from "react";
import { Check, SlidersHorizontal } from "lucide-react";
import { useMusicStore } from "../store/music";
import { defaultWavePreferences, type WavePreferences } from "../types/music";
import { Modal } from "./ui";
import "../styles/wave-tuning.css";

const familiarity = [
  ["balanced", "Баланс", "Знакомое и открытия"],
  ["familiar", "Любимое", "Ближе к вашему вкусу"],
  ["discover", "Незнакомое", "Больше новых имён"],
] as const;
const moods = [
  ["any", "Любое"],
  ["calm", "Спокойное"],
  ["energetic", "Бодрое"],
  ["happy", "Радостное"],
  ["melancholic", "Грустное"],
] as const;
const languages = [
  ["any", "Любой"],
  ["russian", "На русском"],
  ["foreign", "Другие языки"],
  ["instrumental", "Без слов"],
] as const;

export default function WaveTuning() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const saved = useMusicStore((state) => state.settings.wavePreferences);
  const updateSettings = useMusicStore((state) => state.updateSettings);
  const preferences = saved ?? defaultWavePreferences;
  const change = (next: Partial<WavePreferences>) =>
    updateSettings({ wavePreferences: { ...preferences, ...next } });

  return (
    <>
      <button
        type="button"
        className="wave-tuning-trigger"
        aria-label="Настроить волну"
        title="Настроить волну"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={17} aria-hidden="true" />
        <span>Настроить волну</span>
      </button>
      {open && (
        <Modal title="Волна под вас" onClose={close}>
          <div className="wave-tuning-panel">
            <p className="wave-tuning-intro">
              Выберите, что хочется слушать сейчас. Настройки повлияют на
              следующие песни.
            </p>
            <fieldset>
              <legend>Характер музыки</legend>
              <div className="wave-tuning-modes">
                {familiarity.map(([value, label, description]) => (
                  <button
                    type="button"
                    key={value}
                    className="wave-tuning-mode"
                    aria-pressed={preferences.familiarity === value}
                    onClick={() => change({ familiarity: value })}
                  >
                    <strong>{label}</strong>
                    <span>{description}</span>
                    {preferences.familiarity === value && (
                      <Check size={15} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Настроение</legend>
              <div className="wave-tuning-options">
                {moods.map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={preferences.mood === value}
                    onClick={() => change({ mood: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Язык</legend>
              <div className="wave-tuning-options">
                {languages.map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={preferences.language === value}
                    onClick={() => change({ language: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>
            <p className="wave-tuning-note">
              Лайки, дослушивания и пропуски помогают Волне подстроиться под
              вас. «Не нравится» исключает песню из рекомендаций.
            </p>
            <p className="wave-tuning-note">
              Настроение и язык направляют поиск и учитываются по тегам
              источника. У некоторых песен эти сведения могут отсутствовать.
            </p>
            <div className="wave-tuning-footer">
              <button
                type="button"
                className="wave-tuning-reset"
                onClick={() =>
                  updateSettings({
                    wavePreferences: { ...defaultWavePreferences },
                  })
                }
              >
                Вернуть баланс
              </button>
              <button type="button" className="button primary" onClick={close}>
                Готово
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
