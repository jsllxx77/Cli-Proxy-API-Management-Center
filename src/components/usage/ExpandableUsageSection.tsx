import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import styles from '@/pages/UsagePage.module.scss';

export interface ExpandableUsageSectionProps {
  title: ReactNode;
  hint: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}

export function ExpandableUsageSection({
  title,
  hint,
  expanded,
  onToggle,
  children
}: PropsWithChildren<ExpandableUsageSectionProps>) {
  const { t } = useTranslation();

  return (
    <section className={styles.expandableSection}>
      <div className={styles.expandableSectionHeader}>
        <div className={styles.expandableSectionTitleGroup}>
          <h2 className={styles.expandableSectionTitle}>{title}</h2>
          <p className={styles.expandableSectionHint}>{hint}</p>
        </div>
        <Button variant={expanded ? 'ghost' : 'secondary'} size="sm" onClick={onToggle}>
          {expanded ? t('common.collapse') : t('common.expand')}
        </Button>
      </div>

      {expanded ? <div className={styles.expandableSectionBody}>{children}</div> : null}
    </section>
  );
}
