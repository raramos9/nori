import { SignupForm } from '@/components/signup-form';

export const metadata = { title: 'Sign up' };

export default function SignupPage() {
  return (
    <>
      <h1>Create your account</h1>
      <SignupForm />
    </>
  );
}
