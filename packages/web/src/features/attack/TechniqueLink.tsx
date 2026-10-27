import { useTranslation } from 'react-i18next';
import { ExternalLink } from '../../components/ui/ExternalLink';
import { useAttackIndex } from '../../lib/attack';
import { techniqueUrl } from '../../lib/links';

/**
 * Technique by its official English name, with the id after it in monospace, linked to
 * attack.mitre.org. Used inside `TechniqueList`, which waits for the ATT&CK data so ids
 * never flash before the names arrive.
 */
export function TechniqueLink({ id }: { id: string }) {
  const index = useAttackIndex();
  const info = index.data?.technique(id);
  return (
    <ExternalLink href={info?.url ?? techniqueUrl(id)}>
      {info ? <span>{info.name} </span> : null}
      <span className="font-mono text-small">{id}</span>
    </ExternalLink>
  );
}

/** Tactic shortnames as their official names. */
export function TacticNames({ tactics }: { tactics: readonly string[] }) {
  const index = useAttackIndex();
  return <>{tactics.map((tactic) => index.data?.tactic(tactic)?.name ?? tactic).join(', ')}</>;
}

/** Techniques and the tactics they serve, once the names are loaded. */
export function TechniqueList({
  techniques,
  tactics,
}: {
  techniques: readonly string[];
  tactics: readonly string[];
}) {
  const { t } = useTranslation();
  const index = useAttackIndex();
  if (techniques.length === 0) return <p className="text-muted">{t('alertDetail.noTechniques')}</p>;
  if (index.isPending) {
    return (
      <p aria-busy="true" className="text-muted">
        {t('common.loading')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1">
        {techniques.map((technique) => (
          <li key={technique}>
            <TechniqueLink id={technique} />
          </li>
        ))}
      </ul>
      {tactics.length > 0 ? (
        <p className="text-muted">
          {t('alertDetail.tactics')}: <TacticNames tactics={tactics} />
        </p>
      ) : null}
    </div>
  );
}
