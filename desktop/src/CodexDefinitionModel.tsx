import { Settings2 } from "lucide-react";
import { codexSelectionLabel, openCodexSuiteSettings, useCodexSuite } from "./CodexSuite";
import "./CodexSuiteSettings.css";

/** All feature screens share the persisted suite; only its settings page edits selection. */
export function CodexDefinitionModel() {
  const suite = useCodexSuite();
  return <button type="button" className="codex-suite-summary" onClick={openCodexSuiteSettings} aria-label="打开模型设置">
    <Settings2 size={14} />{suite.loaded ? codexSelectionLabel(suite.settings) : "正在读取模型设置…"}
  </button>;
}
