import { useState } from "react";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
export default function SearchEntry() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();
  return (
    <form
      className="search-field glass home-search"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim())
          navigate(`/search?q=${encodeURIComponent(value.trim())}`);
      }}
    >
      <Search size={23} />
      <input
        aria-label="Найти песню или исполнителя"
        placeholder="Какая песня у тебя в голове?"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={300}
      />
      <button className="button primary" type="submit" disabled={!value.trim()}>
        Найти
      </button>
    </form>
  );
}
