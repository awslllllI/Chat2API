/**
 * Mimo Authentication Adapter
 * Authentication method: Cookie-based authentication with in-app browser login
 * 
 * Mimo requires three tokens from cookies:
 * - serviceToken
 * - userId
 * - xiaomichatbot_ph
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const MIMO_WEB_BASE = 'https://aistudio.xiaomimimo.com'

export class MimoAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'mimo',
      authMethods: ['manual', 'cookie'],
      loginUrl: MIMO_WEB_BASE,
      apiUrl: MIMO_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'mimo',
      error: 'Use startInAppLogin for automatic cookie extraction or manually enter tokens',
    }
  }

  async loginWithCookies(providerId: string, cookies: Record<string, string>): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating cookies...')

    const serviceToken = cookies['serviceToken'] || cookies['service_token']
    const userId = cookies['userId'] || cookies['user_id']
    const phToken = cookies['xiaomichatbot_ph'] || cookies['ph_token']

    if (!serviceToken || !userId || !phToken) {
      const missing = []
      if (!serviceToken) missing.push('serviceToken')
      if (!userId) missing.push('userId')
      if (!phToken) missing.push('xiaomichatbot_ph')

      return {
        success: false,
        providerId,
        providerType: 'mimo',
        error: `Missing required cookies: ${missing.join(', ')}`,
      }
    }

    this.emitProgress('success', 'Cookie validation successful')

    return {
      success: true,
      providerId,
      providerType: 'mimo',
      credentials: {
        service_token: serviceToken,
        user_id: userId,
        ph_token: phToken,
      },
      accountInfo: {
        userId: userId,
        name: 'Mimo User',
      },
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // No callback processing needed for cookie-based auth
  }

  /**
   * Validate MiMo credentials by calling a real upstream API.
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const serviceToken = credentials['service_token'] || credentials['serviceToken']
    const userId = credentials['user_id'] || credentials['userId']
    const phToken = credentials['ph_token'] || credentials['xiaomichatbot_ph']

    if (!serviceToken || !userId || !phToken) {
      return {
        valid: false,
        error: 'Missing required credentials: service_token, user_id, ph_token',
      }
    }

    try {
      const response = await axios.post(
        `https://aistudio.xiaomimimo.com/open-apis/resource/genUploadInfo?xiaomichatbot_ph=${encodeURIComponent(phToken)}`,
        {
          fileName: 'probe.png',
          fileSize: 16,
          contentType: 'image/png',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
            Origin: 'https://aistudio.xiaomimimo.com',
            Referer: 'https://aistudio.xiaomimimo.com/',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      )

      if (response.status === 401 || response.data?.code === 401) {
        return {
          valid: false,
          error: 'MiMo 登录已失效，请重新登录后粘贴 service_token / user_id / ph_token',
        }
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          valid: false,
          error: `MiMo 校验失败: HTTP ${response.status}`,
        }
      }

      return {
        valid: true,
        tokenType: 'cookie',
        accountInfo: {
          userId,
          name: 'Mimo User',
        },
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Validation request failed',
      }
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const serviceToken = credentials['service_token'] || credentials['serviceToken']
    const userId = credentials['user_id'] || credentials['userId']
    const phToken = credentials['ph_token'] || credentials['xiaomichatbot_ph']

    if (!serviceToken || !userId || !phToken) {
      return null
    }

    return {
      type: 'cookie',
      value: serviceToken,
      extra: {
        service_token: serviceToken,
        user_id: userId,
        ph_token: phToken,
      },
    }
  }
}

export default MimoAdapter
