import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

export function PageHeading({ eyebrow, title, description, action, badge }: { eyebrow?: string; title: string; description?: string; action?: ReactNode; badge?: string }) {
  return <motion.div className="page-heading" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28 }}><div><div className="heading-eyebrow">{eyebrow && <span>{eyebrow}</span>}{badge && <em>{badge}</em>}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</motion.div>;
}
export function Panel({ children, className = '', title, subtitle, action, icon }: { children: ReactNode; className?: string; title?: string; subtitle?: string; action?: ReactNode; icon?: ReactNode }) {
  return <section className={`panel ${className}`}><>{(title || action) && <div className="panel-heading"><div>{title && <h2>{icon && <span className="panel-title-icon">{icon}</span>}{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action && <div>{action}</div>}</div>}{children}</></section>;
}
export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone.toLowerCase().replaceAll(' ', '-')}`}>{children}</span>; }
export function Button({ children, variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) { return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>; }
export function Modal({ open, onClose, title, description, children, size = 'medium' }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; size?: 'medium' | 'large' }) {
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={e => { if (e.currentTarget === e.target) onClose(); }}><motion.div className={`modal-card modal-${size}`} initial={{ opacity: 0, y: 10, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }}><header className="modal-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></header>{children}</motion.div></div>;
}
export function LoadingBlock({ rows = 4 }: { rows?: number }) { return <div className="loading-block">{Array.from({ length: rows }, (_, i) => <div key={i} className="loading-line" style={{ width: `${72 + (i * 19 % 24)}%` }}/>)}</div>; }
export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><span className="empty-orb">◌</span><h3>{title}</h3><p>{text}</p>{action}</div>; }
export const formatDate = (date: string, options?: Intl.DateTimeFormatOptions) => new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', options || { month: 'short', day: 'numeric' });
