import { ReactNode } from 'react';

type Tone = 'accent' | 'warn' | 'danger' | 'info';

type Props = {
  icon: ReactNode;
  value: string | number;
  label: string;
  sub?: string;
  tone?: Tone;
};

export default function StatCard({ icon, value, label, sub, tone = 'accent' }: Props) {
  return (
    <div className="stat-card">
      <div className={`stat-card-icon tone-${tone}`}>{icon}</div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}
