import axios from 'axios';
import { env } from '@/config/env';

const META_API_VERSION = env.META_API_VERSION;
const META_JWT_TOKEN = env.META_JWT_TOKEN;
const META_NUMBER_ID = env.META_NUMBER_ID;

interface TemplateMessageParams {
  to: string; // Número de teléfono en formato E.164 (ej: +5213326232840)
  templateName: string; // Nombre de la plantilla aprobada en Meta
  languageCode: string; // Código de idioma (ej: 'es', 'en')
  components?: Array<{
    type: 'body' | 'header' | 'button';
    parameters?: Array<{
      type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
      text?: string;
      currency?: { fallback_value: string; code: string; amount_1000: number };
      date_time?: { fallback_value: string };
      image?: { link: string };
      document?: { link: string; filename?: string };
      video?: { link: string };
    }>;
    sub_type?: 'url' | 'quick_reply';
    index?: number;
  }>;
}

/**
 * Envía un mensaje de plantilla usando la API de Meta
 * Esto permite enviar mensajes a usuarios que no han iniciado conversación
 */
export async function sendTemplateMessage(params: TemplateMessageParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!META_JWT_TOKEN || !META_NUMBER_ID) {
    throw new Error('META_JWT_TOKEN y META_NUMBER_ID deben estar configurados en las variables de entorno');
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: params.to,
    type: 'template',
    template: {
      name: params.templateName,
      language: {
        code: params.languageCode,
      },
      ...(params.components && params.components.length > 0 && {
        components: params.components,
      }),
    },
  };

  try {
    console.log(`📤 Enviando mensaje de plantilla a ${params.to}`);
    console.log(`📋 Plantilla: ${params.templateName}`);
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${META_JWT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    console.log(`✅ Mensaje de plantilla enviado exitosamente`);
    console.log(`📨 Message ID: ${response.data.messages?.[0]?.id}`);

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
    };
  } catch (error: any) {
    console.error('❌ Error al enviar mensaje de plantilla:', error.response?.data || error.message);
    
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message || 'Error desconocido',
    };
  }
}

/**
 * Envía una invitación de empleado usando plantilla de Meta
 */
export async function sendEmployeeInvitation(params: {
  phone: string; // Formato E.164 (ej: +5213326232840)
  employeeName: string;
  businessName: string;
  branches: string[]; // Nombres de sucursales
  invitationUrl: string; // URL del link de invitación
  templateName?: string; // Nombre de la plantilla (default: 'employee_invitation')
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const templateName = params.templateName || 'employee_invitation';
  
  // Construir el texto de sucursales
  const branchesText = params.branches.length > 0 
    ? params.branches.join(', ')
    : 'Sucursales asignadas';

  // Componentes de la plantilla según el formato de Meta
  // La plantilla tiene:
  // - HEADER: {{1}} = nombre_negocio
  // - BODY: {{1}} = nombre_negocio, {{2}} = nombre_empleado, {{3}} = sucursales_cliente
  // - BUTTON URL: Opción A) {{4}}, {{5}}, {{6}} (múltiples variables) O Opción B) {{1}} (URL completa)
  // 
  // IMPORTANTE: Los parámetros del header y body son independientes
  // El header tiene su propio {{1}}, y el body tiene su propio {{1}}, {{2}}, {{3}}
  
  // Meta solo permite UNA variable al FINAL de la URL
  // Por eso usamos formato: https://timer.app/invite/{{1}}
  // Donde {{1}} es solo el token (que es único y suficiente para identificar la invitación)
  
  // Extraer el token de la URL
  // Formato esperado: https://{dominio}/invite/{token}
  const urlMatch = params.invitationUrl.match(/\/invite\/([^\/]+)$/);
  const token = urlMatch ? urlMatch[1] : params.invitationUrl.split('/').pop() || '';
  
  const buttonParameters = [
    { type: 'text' as const, text: token }, // {{1}} = token (al final de la URL)
  ];

  const components = [
    {
      type: 'header' as const,
      parameters: [
        {
          type: 'text' as const,
          text: params.businessName, // {{1}} en el header
        },
      ],
    },
    {
      type: 'body' as const,
      parameters: [
        {
          type: 'text' as const,
          text: params.businessName, // {{1}} en el body = nombre_negocio
        },
        {
          type: 'text' as const,
          text: params.employeeName, // {{2}} en el body = nombre_empleado
        },
        {
          type: 'text' as const,
          text: branchesText, // {{3}} en el body = sucursales_cliente
        },
      ],
    },
    {
      type: 'button' as const,
      sub_type: 'url' as const,
      index: 0,
      parameters: buttonParameters,
    },
  ];

  return sendTemplateMessage({
    to: params.phone,
    templateName,
    languageCode: 'es',
    components,
  });
}

