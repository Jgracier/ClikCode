#include <stdio.h>
#include <stdlib.h>
#include <omp.h>
#define N (1L << 27)
int main(void) {
  double *a = malloc(N * sizeof(double));
  double s = 0, best = 0;
  if (!a) return 1;
  #pragma omp parallel for
  for (long i = 0; i < N; i++) a[i] = 1;
  for (int r = 0; r < 5; r++) {
    double start = omp_get_wtime();
    s = 0;
    #pragma omp parallel for reduction(+:s)
    for (long i = 0; i < N; i++) s += a[i];
    double gbps = N * sizeof(double) / (omp_get_wtime() - start) / 1e9;
    if (gbps > best) best = gbps;
  }
  printf("%.3f %g\n", best, s);
  free(a);
  return 0;
}
