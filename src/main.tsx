import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="fatal"><h1>工作台未能打开</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>重新加载</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
