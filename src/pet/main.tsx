import ReactDOM from "react-dom/client";
// 用主窗口同一套主题令牌与字体（App.css 里 html / body 本就是透明底），再叠桌宠自己的样式
import "../App.css";
import "./pet.css";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";

document.documentElement.dataset.platform = IS_MAC ? "mac" : IS_WINDOWS ? "windows" : "linux";
import PetApp from "./PetApp";

// 桌宠小窗入口（pet.html）：不载主窗口那一整套，只有小桌和它的话
ReactDOM.createRoot(document.getElementById("root")!).render(<PetApp />);
