/**
 * Utility functions for managing system WhatsApp numbers distribution
 */

import { createServiceRoleClient } from './auth';

const MAX_EMPLOYEES_PER_NUMBER = 100;

export interface SystemNumber {
  id: string;
  number: string;
  meta_jwt_token: string;
  meta_number_id: string;
  meta_verify_token: string;
  is_active: boolean;
  max_employees: number;
  current_employees_count: number;
}

/**
 * Assigns a system number to a new employee
 * Distributes employees evenly across available numbers
 * Returns the number (without +) that should be assigned
 */
export async function assignSystemNumberToEmployee(): Promise<string | null> {
  const supabase = createServiceRoleClient();

  // Get all active system numbers
  const { data: systemNumbers, error } = await supabase
    .from('system_numbers')
    .select('*')
    .eq('is_active', true)
    .order('current_employees_count', { ascending: true });

  if (error || !systemNumbers || systemNumbers.length === 0) {
    console.warn('No active system numbers found. Employee will not have a system number assigned.');
    return null;
  }

  // Count current employees per number
  const numbersWithCounts = await Promise.all(
    systemNumbers.map(async (sn) => {
      const { count } = await supabase
        .from('employees')
        .select('id', { count: 'exact' })
        .eq('system_number_registered', sn.number)
        .in('status', ['pending', 'active']); // Count both pending and active

      return {
        ...sn,
        current_employees_count: count || 0,
      };
    })
  );

  // Find the number with the least employees that hasn't reached its limit
  const availableNumbers = numbersWithCounts.filter(
    (sn) => sn.current_employees_count < sn.max_employees
  );

  if (availableNumbers.length === 0) {
    // All numbers are at capacity, distribute evenly (round-robin)
    // Find the number with the least employees
    const leastLoaded = numbersWithCounts.reduce((min, current) =>
      current.current_employees_count < min.current_employees_count ? current : min
    );
    return leastLoaded.number;
  }

  // Use the number with the least employees
  const selectedNumber = availableNumbers.reduce((min, current) =>
    current.current_employees_count < min.current_employees_count ? current : min
  );

  return selectedNumber.number;
}

/**
 * Gets system number credentials by number
 */
export async function getSystemNumberCredentials(
  number: string
): Promise<SystemNumber | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('system_numbers')
    .select('*')
    .eq('number', number)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Gets all active system numbers
 */
export async function getAllActiveSystemNumbers(): Promise<SystemNumber[]> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('system_numbers')
    .select('*')
    .eq('is_active', true)
    .order('number', { ascending: true });

  if (error || !data) {
    return [];
  }

  return data;
}

