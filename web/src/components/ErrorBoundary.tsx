import { Component, type ReactNode } from 'react'

type Props = { label: string; children: ReactNode }
type State = { error: Error | null }

/** Keeps a rendering error in one part of the page (map, report, plain-English report) from blanking the whole app. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="error-box">
        <b>{this.props.label} could not be shown.</b> {this.state.error.message}
        <br />
        <span className="muted">Reload the page (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows). The rest of the page still works.</span>
      </div>
    )
  }
}
