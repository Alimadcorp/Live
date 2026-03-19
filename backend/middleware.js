import { NextResponse } from 'next/server';

export function middleware(request) {
  const region = request.geo?.region;

  if (region === 'WA' || region === 'DC') {
    return new NextResponse('Access from your region is restricted.', {
      status: 403,
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/:path*'],
};
