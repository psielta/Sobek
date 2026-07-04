import { createRoot } from "react-dom/client";

function App() {
  return <div>Sobek assistant</div>;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
