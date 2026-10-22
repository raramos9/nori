import { Suspense } from 'react';
import { LoginForm } from '@/components/login-form';

export const metadata = { title: 'Log in' };

export default function LoginPage() {
  return (
    <>
      <h1>Welcome back</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  );
}
