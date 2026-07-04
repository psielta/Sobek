import { createRoot } from "react-dom/client";

function App() {
  return <div>Sobek board</div>;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
