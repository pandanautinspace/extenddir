import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

import Home from './Home';
import Newtab from './Newtab';
import './index.css';

// The new tab page is the home view (Home.jsx) unless the classic lists page was chosen,
// remembered per browser as "frontend".
const loadView = () => {
  try {
    return localStorage.getItem("frontend") ?? "home";
  } catch {
    return "home";
  }
}

const App = () => {
  const [view, updateView] = useState(loadView);
  const change = (view) => {
    try {
      localStorage.setItem("frontend", view);
    } catch { }
    updateView(view);
    window.scrollTo(0, 0);
  }
  return view == "classic"
    ? <Newtab headerExtra={<button onClick={() => change("home")} style={{ fontSize: 12, color: "#4a5568", padding: "0 8px" }}>Home view</button>} />
    : <Home onSwitchView={() => change("classic")} />;
}

const container = document.getElementById('app-container');
const root = createRoot(container);
root.render(<App />);
