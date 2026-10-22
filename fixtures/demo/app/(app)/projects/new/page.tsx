import { NewProjectForm } from '@/components/new-project-form';

export const metadata = { title: 'New project' };

export default function NewProjectPage() {
  return (
    <>
      <h1>New project</h1>
      <NewProjectForm />
    </>
  );
}
