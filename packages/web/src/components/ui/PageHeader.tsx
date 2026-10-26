interface PageHeaderProps {
  title: string;
  description?: string;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      {description ? <p className="mt-1 text-slate-400">{description}</p> : null}
    </header>
  );
}
