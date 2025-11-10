import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, PlanLimitError } from '@/lib/utils/errors';
import { validatePlanLimits } from '@/lib/utils/validation';

const branchSchema = z.object({
  name: z.string().min(3).max(50),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
  tolerance_radius_meters: z.number().min(10).max(200).default(100),
  timezone: z.string().default('America/Mexico_City'),
  business_hours_start: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).default('08:00:00'),
  business_hours_end: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).default('23:00:00'),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || undefined;

    const supabase = createServiceRoleClient();
    let query = supabase
      .from('branches')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId);
    if (status) query = query.eq('status', status);
    const { data: branches, count } = await query;

    // Agregar conteo de empleados activos por sucursal
    if (branches && branches.length > 0) {
      const branchIds = branches.map(b => b.id);
      
      // Obtener empleados activos del negocio
      const { data: activeEmployees } = await supabase
        .from('employees')
        .select('id')
        .eq('business_id', businessId)
        .eq('status', 'active');
      
      const activeEmployeeIds = activeEmployees?.map(e => e.id) || [];
      
      // Obtener relaciones employee_branches activas solo para empleados activos
      const { data: employeeBranches } = activeEmployeeIds.length > 0 ? await supabase
        .from('employee_branches')
        .select('branch_id, employee_id, status')
        .in('branch_id', branchIds)
        .in('employee_id', activeEmployeeIds)
        .eq('status', 'active') : { data: [] };
      
      // Contar empleados activos por sucursal (empleado activo + relación activa)
      const employeeCounts: Record<string, number> = {};
      if (employeeBranches) {
        employeeBranches.forEach(eb => {
          if (eb.status === 'active') {
            employeeCounts[eb.branch_id] = (employeeCounts[eb.branch_id] || 0) + 1;
          }
        });
      }
      
      // Agregar active_employees_count a cada sucursal
      const branchesWithCounts = branches.map(branch => ({
        ...branch,
        active_employees_count: employeeCounts[branch.id] || 0
      }));
      
      return withCors(origin, Response.json({ branches: branchesWithCounts, total: count || 0 }));
    }

    return withCors(origin, Response.json({ branches: branches || [], total: count || 0 }));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json();
    const payload = branchSchema.parse(body);

    const supabase = createServiceRoleClient();
    const limits = await validatePlanLimits(supabase, businessId, 'branches');
    if (!limits.allowed) throw new PlanLimitError('branches', limits.current, limits.max);

    const { data: inserted } = await supabase
      .from('branches')
      .insert({ ...payload, business_id: businessId, status: 'active' })
      .select()
      .single();

    return withCors(origin, Response.json(inserted));
  } catch (error) {
    return handleApiError(error);
  }
}







