import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Layout from "./components/Layout";
import Control from "./pages/Control";
import Analytics from "./pages/Analytics";
import Config from "./pages/Config";

function PrivateRoute({ children }) {
  return localStorage.getItem("token") ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/control" replace />} />
          <Route path="control"   element={<Control />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="config"    element={<Config />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
