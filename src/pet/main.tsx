import ReactDOM from "react-dom/client";
import "./pet.css";
import PetApp from "./PetApp";

// 桌宠小窗入口（pet.html）：不载主窗口那一整套，只有小桌和它的话
ReactDOM.createRoot(document.getElementById("root")!).render(<PetApp />);
