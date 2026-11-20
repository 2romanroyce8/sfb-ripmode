import type { ReactNode } from 'react';
import './staff/light.generated.css';
import './staff/appearance.css';
import './staff/team-chat.css';
import './staff/invitation-cards.css';
import './staff/team.css';
import './staff/staff.css';
import './staff/productivity.css';

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body className="sfb-hq sfb-staff">{children}</body></html>;
}
