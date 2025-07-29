import {
  AudioReceiveStream,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import crypto from 'crypto'
import { AttachmentBuilder, Channel, VoiceState, Webhook } from 'discord.js'
import fs from 'fs'
import { BaseModule } from 'mopo-discordjs'
import { IOptions, nodewhisper } from 'nodejs-whisper'
import path from 'path'
import prism from 'prism-media'
import shell from 'shelljs'
import { pipeline } from 'stream/promises'

import { ModelName } from '@/types/ModelName'
export interface TranscriptionOption {
  sendRealtimeMessage: boolean
  exportReport: boolean
  exportAudio: boolean
}

interface GuildSession {
  queue: {
    uuid: string
    userId: string
    sendChannelId: string
    guildId: string
    originalIndex: number // 追加: 元の順序を保持
  }[]
  isQueueProcessing: boolean
  option: TranscriptionOption
  report: string
  audioRecordings: {
    uuid: string
    userId: string
    startTime: number
    endTime?: number
    filePath: string
  }[]
  sessionStartTime: number
  onCompleteCallback?: () => Promise<void>
  subscribedUsers: Set<string>
  activeStreams: Map<string, AudioReceiveStream>
  lastUsedChannelId?: string
  queueCounter: number // 追加: キューの連番管理
}

export default class Transcription extends BaseModule {
  private static readonly TEMP_DIR = path.resolve(
    __dirname, // transcription
    '../', // modules
    '../', // app
    '../', // src
    '../', // project root
    'temp',
  )

  private static readonly AFTER_SILENCE_DURATION = 800 // ms

  private static readonly whisperOptions: IOptions = {
    modelName: ModelName.LARGE_V3_TURBO,
    autoDownloadModelName: ModelName.LARGE_V3_TURBO,
    removeWavFileAfterTranscription: false,
    withCuda: true,
    logger: console,
    whisperOptions: {
      outputInCsv: false,
      outputInJson: false,
      outputInJsonFull: false,
      outputInLrc: false,
      outputInSrt: false,
      outputInText: false,
      outputInVtt: false,
      outputInWords: false,
      translateToEnglish: false,
      language: 'ja',
      wordTimestamps: false,
      timestamps_length: 20,
      splitOnWord: true,
    },
  }

  private guildSessions = new Map<string, GuildSession>()

  private static getGuildTempDir(guildId: string): string {
    return path.join(Transcription.TEMP_DIR, guildId)
  }

  private static ensureGuildTempDir(guildId: string): void {
    const guildDir = Transcription.getGuildTempDir(guildId)
    if (!fs.existsSync(guildDir)) fs.mkdirSync(guildDir, { recursive: true })
  }

  public getGuildInProgress(guildId: string): boolean {
    const session = this.guildSessions.get(guildId)
    return session
      ? session.isQueueProcessing || session.queue.length > 0
      : false
  }

  public stopAndExport(
    guildId: string,
    onComplete?: () => Promise<void>,
  ): boolean {
    const connection = getVoiceConnection(guildId)
    if (!connection) return false

    const session = this.guildSessions.get(guildId)
    if (session) {
      if (onComplete) session.onCompleteCallback = onComplete
      // 接続を破棄する前にアクティブなストリームをクリーンアップ
      this.cleanupActiveStreams(session)
    }

    connection.destroy()
    return true
  }

  private getOrCreateGuildSession(guildId: string): GuildSession {
    let session = this.guildSessions.get(guildId)
    if (!session) {
      session = {
        queue: [],
        isQueueProcessing: false,
        option: {
          sendRealtimeMessage: false,
          exportReport: false,
          exportAudio: false,
        },
        report: '',
        audioRecordings: [],
        sessionStartTime: Date.now(),
        subscribedUsers: new Set(),
        activeStreams: new Map(),
        queueCounter: 0, // 追加: カウンター初期化
      }
      this.guildSessions.set(guildId, session)
    }
    return session
  }

  public init(): void {
    this.client.on(
      'voiceStateUpdate',
      (oldState: VoiceState, newState: VoiceState): void => {
        void (async (): Promise<void> => {
          const connection = getVoiceConnection(newState.guild.id)
          if (!connection?.joinConfig.channelId) return
          if (oldState.channelId !== connection.joinConfig.channelId) return

          const channel = await newState.guild.channels.fetch(
            connection.joinConfig.channelId,
          )
          if (!channel?.isVoiceBased()) return

          const unBotMembers = channel.members.filter(
            (member) => !member.user.bot,
          )
          if (unBotMembers.size === 0) {
            connection.destroy()
            return
          }
        })()
      },
    )
  }

  public start(connection: VoiceConnection, option: TranscriptionOption): void {
    const guildId = connection.joinConfig.guildId
    const session = this.getOrCreateGuildSession(guildId)
    session.option = option
    
    // 最後に使用されたチャンネルIDを保存
    if (connection.joinConfig.channelId) {
      session.lastUsedChannelId = connection.joinConfig.channelId
    }

    connection.receiver.speaking.on('start', (userId) => {
      if (session.subscribedUsers.has(userId)) {
        console.log(
          `[discord-whisper]User ${userId} is already subscribed, skipping`,
        )
        return
      }

      console.log(`[discord-whisper]User ${userId} started speaking`)
      const uuid = crypto.randomUUID()
      const currentTime = Date.now()

      if (session.option.exportAudio) {
        Transcription.ensureGuildTempDir(guildId)
        session.audioRecordings.push({
          uuid: uuid,
          userId: userId,
          startTime: currentTime,
          filePath: path.join(
            Transcription.getGuildTempDir(guildId),
            `${uuid}.wav`,
          ),
        })
      }

      const opusStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: Transcription.AFTER_SILENCE_DURATION,
        },
      })

      session.subscribedUsers.add(userId)
      session.activeStreams.set(userId, opusStream)

      opusStream.on('end', () => {
        void (async (): Promise<void> => {
          if (!connection.joinConfig.channelId) {
            console.warn(
              '[discord-whisper]No channel ID found in connection join config',
            )
            return
          }
          console.log(`[discord-whisper]Stream from user ${userId} has ended`)

          session.subscribedUsers.delete(userId)
          session.activeStreams.delete(userId)
          if (session.option.exportAudio) {
            console.log(
              `[discord-whisper]Looking for recording with UUID: ${uuid}`,
            )

            const recording = session.audioRecordings.find(
              (r: { uuid: string; userId: string; startTime: number; endTime?: number; filePath: string }) => r.uuid === uuid,
            )

            if (recording) {
              recording.endTime = Date.now()
              console.log(
                `[discord-whisper]Set endTime for UUID ${uuid}: ${String(recording.endTime)}`,
              )
            } else {
              console.warn(
                `[discord-whisper]Recording not found for UUID: ${uuid}`,
              )
            }
          }

          opusStream.destroy()
          await this.encodePcmToWav(guildId, uuid)
          if (this.isValidVoiceData(guildId, uuid)) {
            // 順序番号を付与してキューに追加
            session.queue.push({
              uuid: uuid,
              userId: userId,
              sendChannelId: connection.joinConfig.channelId,
              guildId: guildId,
              originalIndex: session.queueCounter++, // 追加: 順序番号
            })
            if (!session.isQueueProcessing) await this.progressQueue(guildId)
          }
          fs.unlinkSync(
            path.join(Transcription.getGuildTempDir(guildId), `${uuid}.pcm`),
          )
        })()
      })

      opusStream.on('error', (error) => {
        console.error(
          `[discord-whisper]Stream error for user ${userId}:`,
          error,
        )
        session.subscribedUsers.delete(userId)
        session.activeStreams.delete(userId)
        opusStream.destroy()
      })

      void this.encodeOpusToPcm(guildId, uuid, opusStream)
    })

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(
        '[discord-whisper]The connection has entered the Ready state - ready to play audio!',
      )
    })

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async (): Promise<void> => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
        } catch {
          connection.destroy()
        }
      })()
    })

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('[discord-whisper]The connection has been destroyed')

      // アクティブなストリームを安全にクリーンアップ
      this.cleanupActiveStreams(session)
      session.subscribedUsers.clear()

      const interval = setInterval(() => {
        void (async (): Promise<void> => {
          if (session.queue.length === 0) {
            clearInterval(interval)
            
            let reportPath: string | null = null
            let audioPath: string | null = null
            
            // レポートファイルの出力
            if (session.option.exportReport && session.report.length > 0) {
              reportPath = await this.exportReport(guildId, session)
            }
            
            // 音声ファイルのマージ
            if (session.option.exportAudio && session.audioRecordings.length > 0) {
              audioPath = await this.mergeAudioFiles(guildId, session)
            }
            
            // ファイルをDiscordに送信
            if (reportPath || audioPath) {
              await this.sendFilesToDiscord(guildId, session, reportPath, audioPath)
            }
            
            // onCompleteCallbackを実行
            if (session.onCompleteCallback) {
              try {
                await session.onCompleteCallback()
                console.log('[discord-whisper]onCompleteCallback executed successfully')
              } catch (error) {
                console.error('[discord-whisper]Error in onCompleteCallback:', error)
              }
            }
            
            this.cleanupTempFiles(guildId)
            this.guildSessions.delete(guildId)
            console.log(`[discord-whisper]Session cleanup completed for guild ${guildId}`)
            return
          }
        })()
      }, 1000)
    })
  }

  private async encodeOpusToPcm(
    guildId: string,
    uuid: string,
    opusStream: AudioReceiveStream,
  ): Promise<void> {
    try {
      const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      })

      Transcription.ensureGuildTempDir(guildId)
      const out = fs.createWriteStream(
        path.join(Transcription.getGuildTempDir(guildId), `${uuid}.pcm`),
      )

      // ストリームのエラーハンドリングを追加
      opusStream.on('error', (error) => {
        console.warn(`[discord-whisper]OpusStream error during encoding for UUID ${uuid}:`, error)
      })

      opusDecoder.on('error', (error) => {
        console.warn(`[discord-whisper]OpusDecoder error for UUID ${uuid}:`, error)
      })

      out.on('error', (error) => {
        console.warn(`[discord-whisper]WriteStream error for UUID ${uuid}:`, error)
      })

      await pipeline(
        opusStream as unknown as NodeJS.ReadableStream,
        opusDecoder as unknown as NodeJS.WritableStream,
        out as unknown as NodeJS.WritableStream,
      ).catch((error) => {
        console.warn(`[discord-whisper]Pipeline error for UUID ${uuid}:`, error)
        // パイプラインエラーは無視（接続切断時によく発生するため）
      })
    } catch (error) {
      console.warn(`[discord-whisper]Error in encodeOpusToPcm for UUID ${uuid}:`, error)
    }
  }

  private async encodePcmToWav(guildId: string, uuid: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      console.log(`[discord-whisper]Encoding PCM to WAV for UUID: ${uuid}`)
      const pcmFilePath = path.join(
        Transcription.getGuildTempDir(guildId),
        `${uuid}.pcm`,
      )
      const wavFilePath = path.join(
        Transcription.getGuildTempDir(guildId),
        `${uuid}.wav`,
      )

      const command = `ffmpeg -f s16le -ar 48k -ac 2 -i "${pcmFilePath}" "${wavFilePath}"`
      const result = shell.exec(command)
      if (result.code !== 0)
        reject(new Error(`Failed to encode PCM to WAV: ${result.stderr}`))
      resolve()
    })
  }

  private async transcribeAudio(
    guildId: string,
    uuid: string,
  ): Promise<string | undefined> {
    console.log(`[discord-whisper]Transcribing audio for UUID: ${uuid}`)
    const wavFilePath = path.join(
      Transcription.getGuildTempDir(guildId),
      `${uuid}.wav`,
    )
    if (!fs.existsSync(wavFilePath)) {
      console.error(`[discord-whisper]WAV file not found: ${wavFilePath}`)
      return
    }
    const context = await nodewhisper(
      wavFilePath,
      Transcription.whisperOptions,
    ).catch((error: unknown) => {
      console.error(
        `[discord-whisper]Error during transcription for UUID ${uuid}:`,
        error,
      )
      return ''
    })

    const cleanedContext = context.replace(/(?=\[).*?(?<=\])\s\s/g, '')

    if (!this.isValidJapaneseTranscription(cleanedContext)) {
      console.warn(
        `[discord-whisper]Transcription failed Japanese validation: "${cleanedContext}"`,
      )
      return undefined
    }

    return cleanedContext
  }

  private async fetchWebhook(channel: Channel): Promise<Webhook | undefined> {
    if (!channel.isVoiceBased()) return
    const webhooks = await channel.fetchWebhooks()
    return (
      webhooks.find((v) => v.token) ??
      (await channel.createWebhook({
        name: this.client.user?.username ?? 'Transcription Bot',
      }))
    )
  }

  private async sendWebhookMessage(
    webhook: Webhook,
    userId: string,
    message: string,
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(userId)
      const guild = await this.client.guilds.fetch(webhook.guildId)
      const member = await guild.members.fetch(userId).catch(() => undefined)

      const webhookOption = {
        username: member?.displayName ?? user.displayName,
        avatarURL: member?.displayAvatarURL() ?? user.displayAvatarURL(),
      }

      await webhook.send({
        ...webhookOption,
        content: message,
      })
      console.log('[discord-whisper]Webhook message sent successfully')
    } catch (error) {
      console.error('[discord-whisper]Error sending webhook message:', error)
    }
  }

  private async progressQueue(guildId: string): Promise<void> {
    const session = this.getOrCreateGuildSession(guildId)
    session.isQueueProcessing = true
    
    // 並列処理用の設定
    const maxConcurrentTranscriptions = 3 // 同時処理数
    const batchSize = Math.min(maxConcurrentTranscriptions, session.queue.length)
    
    if (batchSize === 0) {
      session.isQueueProcessing = false
      return
    }
    
    // バッチで処理（元の順序インデックスを保持）
    const batch = session.queue.splice(0, batchSize)
    const transcriptionPromises = batch.map(async (item) => {
      const context = await this.transcribeAudio(item.guildId, item.uuid)
      return { 
        item, 
        context, 
        originalIndex: item.originalIndex // 元の順序インデックスを保持
      }
    })
    
    try {
      const results = await Promise.all(transcriptionPromises)
      
      // 元の順序でソート（originalIndexで並び替え）
      results.sort((a, b) => a.originalIndex - b.originalIndex)
      
      console.log(
        `[discord-whisper]Processing ${results.length} transcription results in original order: ${results.map(r => r.originalIndex).join(', ')}`
      )
      
      // 順序を保持して処理
      for (const { item, context } of results) {
        if (context) {
          console.log(
            `[discord-whisper]Processing transcription in order - Index: ${item.originalIndex}, Content: "${context.substring(0, 50)}..."`
          )
          
          // リアルタイムメッセージ送信（順序保持）
          if (item.sendChannelId && session.option.sendRealtimeMessage) {
            const channel = await this.client.channels.fetch(item.sendChannelId)
            if (channel?.isVoiceBased()) {
              const webhook = await this.fetchWebhook(channel)
              if (webhook) {
                await this.sendWebhookMessage(webhook, item.userId, context)
              }
            }
          }
          
          // レポート追加（順序保持）
          if (session.option.exportReport) {
            const user = await this.client.users.fetch(item.userId)
            const recording = session.audioRecordings.find(r => r.uuid === item.uuid)
            let timeInfo = ''
            if (recording) {
              const startTime = new Date(recording.startTime).toLocaleString('ja-JP')
              timeInfo = ` [${startTime}]`
            }
            
            session.report += `User: ${user.displayName}(ID:${item.userId})${timeInfo}\n`
            session.report += `Transcription: ${context}\n\n`
          }
        } else {
          console.log(
            `[discord-whisper]Skipping invalid transcription - Index: ${item.originalIndex}`
          )
        }
      }
    } catch (error) {
      console.error('[discord-whisper]Error in batch transcription:', error)
    }
    
    // 残りのキューがある場合は再帰処理
    if (session.queue.length > 0) {
      void this.progressQueue(guildId)
    } else {
      session.isQueueProcessing = false
    }
  }

  private isValidVoiceData(guildId: string, uuid: string): boolean {
    const pcmFilePath = path.join(
      Transcription.getGuildTempDir(guildId),
      `${uuid}.pcm`,
    )
    if (!fs.existsSync(pcmFilePath)) {
      console.warn(`[discord-whisper]PCM file not found: ${pcmFilePath}`)
      return false
    }

    const stats = fs.statSync(pcmFilePath)
    const fileSizeInBytes = stats.size
    const durationInSeconds = fileSizeInBytes / (48000 * 2 * 2) // 48kHz, 2 channels, 2 bytes per sample

    if (durationInSeconds < 0.5) {
      console.warn(
        `[discord-whisper]PCM file too short: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
      )
      return false
    }

    if (durationInSeconds > 30) {
      console.warn(
        `[discord-whisper]PCM file too long: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
      )
      return false
    }

    if (!this.hasValidAudioLevel(pcmFilePath)) {
      console.warn(
        `[discord-whisper]PCM file has insufficient audio level: ${pcmFilePath}`,
      )
      return false
    }

    if (!this.detectVoiceActivity(pcmFilePath, durationInSeconds)) {
      console.warn(
        `[discord-whisper]No voice activity detected: ${pcmFilePath}`,
      )
      return false
    }

    console.log(
      `[discord-whisper]PCM file is valid: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
    )
    return true
  }

  private hasValidAudioLevel(pcmFilePath: string): boolean {
    try {
      const pcmData = fs.readFileSync(pcmFilePath)
      let sumSquared = 0
      let maxAmplitude = 0
      const sampleCount = pcmData.length / 2 // 16-bit samples

      // Reads PCM data as 16-bit samples and calculates RMS
      for (let i = 0; i < pcmData.length; i += 2) {
        const sample = pcmData.readInt16LE(i)
        const amplitude = Math.abs(sample)
        sumSquared += sample * sample
        maxAmplitude = Math.max(maxAmplitude, amplitude)
      }

      const rms = Math.sqrt(sumSquared / sampleCount)
      const rmsDb = 20 * Math.log10(rms / 32767) // dB calculation based on 16-bit max

      // Volume threshold: above -40dB, max amplitude above 1000
      const hasValidRms = rmsDb > -40
      const hasValidPeak = maxAmplitude > 1000

      console.log(
        `[discord-whisper]Audio level check - RMS: ${rmsDb.toFixed(2)}dB, Peak: ${maxAmplitude.toString()}, Valid: ${String(hasValidRms && hasValidPeak)}`,
      )

      return hasValidRms && hasValidPeak
    } catch (error) {
      console.error('[discord-whisper]Error analyzing audio level:', error)
      return false
    }
  }

  private detectVoiceActivity(
    pcmFilePath: string,
    durationInSeconds: number,
  ): boolean {
    try {
      const pcmData = fs.readFileSync(pcmFilePath)
      const sampleRate = 48000
      const channels = 2
      const frameSize = Math.floor(sampleRate * 0.025) * channels * 2 // 25ms frames
      const frameCount = Math.floor(pcmData.length / frameSize)

      let voiceFrames = 0
      const energyThreshold = 1000000 // Energy threshold

      // Future expansion: dynamic threshold adjustment using durationInSeconds is possible
      // Currently using fixed threshold
      const adaptiveThreshold =
        durationInSeconds > 2 ? energyThreshold * 0.8 : energyThreshold

      for (let frame = 0; frame < frameCount; frame++) {
        const frameStart = frame * frameSize
        const frameEnd = Math.min(frameStart + frameSize, pcmData.length)
        let frameEnergy = 0

        for (let i = frameStart; i < frameEnd; i += 2) {
          const sample = pcmData.readInt16LE(i)
          frameEnergy += sample * sample
        }

        if (frameEnergy > adaptiveThreshold) voiceFrames++
      }

      const voiceRatio = voiceFrames / frameCount
      const minVoiceRatio = 0.1 // Audio must be detected in at least 10% of frames

      console.log(
        `[discord-whisper]VAD analysis - Voice frames: ${voiceFrames.toString()}/${frameCount.toString()} (${(voiceRatio * 100).toFixed(1)}%), Valid: ${String(voiceRatio >= minVoiceRatio)}`,
      )

      return voiceRatio >= minVoiceRatio
    } catch (error) {
      console.error(
        '[discord-whisper]Error in voice activity detection:',
        error,
      )
      return false
    }
  }

  private isValidJapaneseTranscription(text: string): boolean {
    if (!text || text.trim().length === 0) return false

    const trimmedText = text.trim()

    if (trimmedText.length < 2) return false

    if (trimmedText.length > 200) {
      console.warn(
        `[discord-whisper]Transcription too long (${trimmedText.length.toString()} chars)`,
      )
      return false
    }

    // "ご視聴ありがとうございました" と "はぁはぁ" は厳密にスキップ
    if (trimmedText.includes('ご視聴ありがとうございました') || trimmedText.includes('はぁはぁ')) {
      console.warn(
      `[discord-whisper]Filtered strict false positive: "${trimmedText}"`,
      )
      return false
    }

    const commonFalsePositives = [
      'はい',
      'あん',
      // 'いえ',
      // 'うん',
      // 'そう',
      '...',
      '。。。',
      // 'えーと',
      // 'あのー',
      // 'まあ',
      // 'ちょっと',
      'Thank you',
      'thank you',
    ]

    if (trimmedText.length <= 5) {
      const isCommonFalsePositive = commonFalsePositives.some((pattern) =>
        trimmedText.includes(pattern),
      )
      if (isCommonFalsePositive) {
        console.warn(
          `[discord-whisper]Filtered common false positive: "${trimmedText}"`,
        )
        return false
      }
    }

    const japaneseCharRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/
    const hasJapaneseChars = japaneseCharRegex.test(trimmedText)

    const englishOnlyRegex = /^[a-zA-Z\s.,!?]+$/
    const isEnglishOnly = englishOnlyRegex.test(trimmedText)

    if (isEnglishOnly) {
      console.warn(
        `[discord-whisper]Filtered English-only transcription: "${trimmedText}"`,
      )
      return false
    }

    const symbolOnlyRegex = /^[.,!?。、！？\s\-_]+$/
    const isSymbolOnly = symbolOnlyRegex.test(trimmedText)

    if (isSymbolOnly) {
      console.warn(
        `[discord-whisper]Filtered symbol-only transcription: "${trimmedText}"`,
      )
      return false
    }

    if (!hasJapaneseChars) {
      console.warn(
        `[discord-whisper]No Japanese characters found: "${trimmedText}"`,
      )
      return false
    }

    console.log(
      `[discord-whisper]Valid Japanese transcription: "${trimmedText}"`,
    )
    return true
  }

  private async exportReport(guildId: string, session: GuildSession): Promise<string | null> {
    try {
      console.log(`[discord-whisper]Exporting report for guild ${guildId}`)
      
      const startTime = this.formatDateForFilename(session.sessionStartTime)
      const endTime = this.formatDateForFilename(Date.now())
      const reportFileName = `transcription_text_${startTime}_${endTime}.txt`
      const reportFilePath = path.join(
        Transcription.getGuildTempDir(guildId),
        reportFileName
      )
      
      let reportContent = `Discord Whisper Transcription Report\n`
      reportContent += `Guild ID: ${guildId}\n`
      reportContent += `Session Start: ${new Date(session.sessionStartTime).toLocaleString('ja-JP')}\n`
      reportContent += `Session End: ${new Date().toLocaleString('ja-JP')}\n`
      reportContent += `Total Transcriptions: ${session.report.split('User:').length - 1}\n`
      reportContent += `\n${'='.repeat(50)}\n\n`
      reportContent += session.report
      
      fs.writeFileSync(reportFilePath, reportContent, 'utf8')
      console.log(`[discord-whisper]Report exported successfully: ${reportFilePath}`)
      return reportFilePath
    } catch (error) {
      console.error(`[discord-whisper]Error exporting report for guild ${guildId}:`, error)
      return null
    }
  }

  private async sendFilesToDiscord(
    guildId: string, 
    session: GuildSession, 
    reportPath: string | null, 
    audioPath: string | null
  ): Promise<void> {
    try {
      // 送信先チャンネルを決定（優先順位: 最新キューのチャンネル → lastUsedChannelId → 接続情報）
      const lastQueueItem = session.queue[session.queue.length - 1]
      let channelId: string | undefined = lastQueueItem?.sendChannelId || session.lastUsedChannelId
      
      // 上記で見つからない場合、接続情報から取得を試みる
      if (!channelId) {
        const connection = getVoiceConnection(guildId)
        channelId = connection?.joinConfig.channelId || undefined
      }
      
      if (!channelId) {
        console.warn(`[discord-whisper]No channel found to send files for guild ${guildId}`)
        return
      }
      
      const channel = await this.client.channels.fetch(channelId)
      if (!channel?.isTextBased() || !('send' in channel)) {
        console.warn(`[discord-whisper]Channel ${channelId} is not a sendable text channel`)
        return
      }
      
      // レポートファイルを送信
      if (reportPath && fs.existsSync(reportPath)) {
        await this.sendSingleFile(channel, reportPath, '📄 文字起こしレポートファイル', session)
      }
      
      // 音声ファイルを送信（大きい場合は分割）
      if (audioPath && fs.existsSync(audioPath)) {
        await this.sendAudioFile(channel, audioPath, session, guildId)
      }
      
      console.log(`[discord-whisper]Files sent successfully to channel ${channelId}`)
      
    } catch (error) {
      console.error(`[discord-whisper]Error sending files to Discord:`, error)
    }
  }

  private async sendSingleFile(
    channel: any,
    filePath: string,
    description: string,
    session: GuildSession
  ): Promise<void> {
    const fileSize = fs.statSync(filePath).size
    const maxSize = 10 * 1024 * 1024 // 10MB制限
    
    if (fileSize > maxSize) {
      console.warn(`[discord-whisper]File too large (${(fileSize / 1024 / 1024).toFixed(2)}MB): ${filePath}`)
      await channel.send({
        content: `⚠️ ${description}のサイズが大きすぎるため送信できません (${(fileSize / 1024 / 1024).toFixed(2)}MB > 10MB)\n` +
                 `ファイルパス: \`${filePath}\``
      })
      return
    }
    
    const attachment = new AttachmentBuilder(filePath, {
      name: path.basename(filePath)
    })
    
    let messageContent = '📝 **文字起こしセッション完了**\n\n'
    messageContent += `${description}\n`
    messageContent += `ファイルサイズ: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n`
    messageContent += `\n⏱️ セッション時間: ${new Date(session.sessionStartTime).toLocaleString('ja-JP')} - ${new Date().toLocaleString('ja-JP')}`
    
    await channel.send({
      content: messageContent,
      files: [attachment]
    })
  }

  private async sendAudioFile(
    channel: any,
    audioPath: string,
    session: GuildSession,
    guildId: string
  ): Promise<void> {
    const fileSize = fs.statSync(audioPath).size
    const maxSize = 10 * 1024 * 1024 // 10MB制限
    
    if (fileSize <= maxSize) {
      // ファイルサイズが制限内の場合、そのまま送信
      const attachment = new AttachmentBuilder(audioPath, {
        name: path.basename(audioPath)
      })
      
      let messageContent = '🎵 **マージされた音声ファイル**\n\n'
      messageContent += `ファイルサイズ: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n`
      messageContent += `⏱️ セッション時間: ${new Date(session.sessionStartTime).toLocaleString('ja-JP')} - ${new Date().toLocaleString('ja-JP')}`
      
      await channel.send({
        content: messageContent,
        files: [attachment]
      })
    } else {
      // ファイルサイズが制限を超える場合、分割
      console.log(`[discord-whisper]Audio file too large (${(fileSize / 1024 / 1024).toFixed(2)}MB), splitting...`)
      await this.splitAndSendAudioFile(channel, audioPath, session, guildId)
    }
  }

  private async splitAndSendAudioFile(
    channel: any,
    audioPath: string,
    session: GuildSession,
    guildId: string
  ): Promise<void> {
    try {
      // 音声ファイルの長さを取得
      const durationResult = shell.exec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`, { silent: true })
      if (durationResult.code !== 0) {
        throw new Error('Failed to get audio duration')
      }
      
      const totalDuration = parseFloat(durationResult.stdout.trim())
      const targetSize = 9.9 * 1024 * 1024 // 9.9MBを目標サイズとして設定（安全マージン）
      const currentSize = fs.statSync(audioPath).size
      const estimatedSegmentDuration = (totalDuration * targetSize) / currentSize
      
      // セグメント長を調整（最低2分、最大10分）
      const segmentDuration = Math.max(120, Math.min(600, estimatedSegmentDuration))
      const segmentCount = Math.ceil(totalDuration / segmentDuration)
      
      console.log(`[discord-whisper]Splitting audio into ${segmentCount} segments of ${segmentDuration}s each`)
      
      // 分割情報を送信
      await channel.send({
        content: `🎵 **音声ファイル分割送信**\n\n` +
                 `元ファイルサイズ: ${(currentSize / 1024 / 1024).toFixed(2)}MB\n` +
                 `分割数: ${segmentCount}個\n` +
                 `各セグメント長: 約${Math.round(segmentDuration / 60)}分\n\n` +
                 `分割ファイルを順次送信します...`
      })
      
      // 各セグメントを作成・送信
      for (let i = 0; i < segmentCount; i++) {
        const startTime = i * segmentDuration
        
        // ファイル名から開始時刻と終了時刻を抽出
        const audioFileName = path.basename(audioPath, '.mp3')
        const timeMatch = audioFileName.match(/transcription_audio_(\d{8}_\d{6})_(\d{8}_\d{6})/)
        let segmentFileName: string
        
        if (timeMatch) {
          const sessionStart = timeMatch[1]
          const sessionEnd = timeMatch[2]
          segmentFileName = `transcription_audio_${sessionStart}_${sessionEnd}_${i + 1}_${segmentCount}.mp3`
        } else {
          // フォールバック（既存の形式が見つからない場合）
          segmentFileName = `split_${i + 1}_of_${segmentCount}_${audioFileName}.mp3`
        }
        
        const segmentPath = path.join(
          Transcription.getGuildTempDir(guildId),
          segmentFileName
        )
        
        // FFmpegでセグメントを作成
        const splitCommand = `ffmpeg -y -i "${audioPath}" -ss ${startTime} -t ${segmentDuration} -c copy "${segmentPath}"`
        const splitResult = shell.exec(splitCommand, { silent: true })
        
        if (splitResult.code !== 0) {
          console.error(`[discord-whisper]Failed to create segment ${i + 1}`)
          continue
        }
        
        // セグメントを送信
        const segmentSize = fs.statSync(segmentPath).size
        const attachment = new AttachmentBuilder(segmentPath, {
          name: path.basename(segmentPath)
        })
        
        await channel.send({
          content: `🎵 **音声ファイル (${i + 1}/${segmentCount})**\n` +
                   `サイズ: ${(segmentSize / 1024 / 1024).toFixed(2)}MB\n` +
                   `時間: ${this.formatTime(startTime)} - ${this.formatTime(startTime + segmentDuration)}`,
          files: [attachment]
        })
        
        // セグメントファイルを削除
        try {
          fs.unlinkSync(segmentPath)
        } catch (error) {
          console.warn(`[discord-whisper]Failed to delete segment file: ${segmentPath}`)
        }
        
        // 送信間隔を空ける（Discord API制限対策）
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
      await channel.send({
        content: `✅ **音声ファイル分割送信完了**\n\n` +
                 `⏱️ セッション時間: ${new Date(session.sessionStartTime).toLocaleString('ja-JP')} - ${new Date().toLocaleString('ja-JP')}`
      })
      
    } catch (error) {
      console.error(`[discord-whisper]Error splitting audio file:`, error)
      await channel.send({
        content: `❌ **音声ファイルの分割送信に失敗しました**\n\n` +
                 `エラー: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
                 `ファイルパス: \`${audioPath}\``
      })
    }
  }

  private formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.floor(seconds % 60)
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  private formatDateForFilename(timestamp: number): string {
    const date = new Date(timestamp)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    const second = String(date.getSeconds()).padStart(2, '0')
    return `${year}${month}${day}_${hour}${minute}${second}`
  }

  private static readonly CONFIG = {
    MAX_FILE_SIZE: 10.0 * 1024 * 1024, // 10MB
    TARGET_SPLIT_SIZE: 9.99 * 1024 * 1024, // 9.99MB
    MIN_SEGMENT_DURATION: 120, // 2分
    MAX_SEGMENT_DURATION: 600, // 10分
    BATCH_SIZE: 15,
    SEND_DELAY: 1000, // 1秒
  } as const

  private cleanupActiveStreams(session: GuildSession): void {
    console.log(`[discord-whisper]Cleaning up ${session.activeStreams.size} active streams`)
    
    session.activeStreams.forEach((stream, userId) => {
      try {
        if (!stream.destroyed) {
          stream.removeAllListeners()
          stream.destroy()
        }
      } catch (error) {
        console.warn(`[discord-whisper]Error cleaning up stream for user ${userId}:`, error)
      }
    })
    
    session.activeStreams.clear()
  }

  private cleanupTempFiles(guildId: string): void {
    const guildDir = Transcription.getGuildTempDir(guildId)
    if (fs.existsSync(guildDir)) {
      try {
        const files = fs.readdirSync(guildDir)
        files.forEach((file) => {
          // transcription_audio_ファイルとtranscription_text_ファイルは保持
          if (file.startsWith('transcription_audio_') || file.startsWith('transcription_text_')) return
          const filePath = path.join(guildDir, file)
          fs.unlinkSync(filePath)
          console.log(`[discord-whisper]Deleted temp file: ${file}`)
        })
        
        // ディレクトリが空でない場合は削除しない（レポートや音声ファイルが残っているため）
        const remainingFiles = fs.readdirSync(guildDir)
        if (remainingFiles.length === 0) {
          fs.rmdirSync(guildDir)
          console.log(`[discord-whisper]Deleted empty guild temp directory: ${guildDir}`)
        } else {
          console.log(`[discord-whisper]Guild temp directory preserved (${remainingFiles.length} files remaining): ${guildDir}`)
        }
      } catch (error) {
        console.error(
          `[discord-whisper]Error cleaning up temp files for guild ${guildId}:`,
          error,
        )
      }
    }
  }

  private async mergeAudioFiles(
    guildId: string,
    session: GuildSession,
  ): Promise<string | null> {
    try {
      console.log(`[discord-whisper]Merging audio files for guild ${guildId}`)

      const validRecordings = session.audioRecordings.filter(
        (recording) => recording.endTime && fs.existsSync(recording.filePath),
      )

      if (validRecordings.length === 0) {
        console.warn(
          `[discord-whisper]No valid recordings found for guild ${guildId}`,
        )
        return null
      }

      validRecordings.sort((a, b) => a.startTime - b.startTime)

      const startTime = this.formatDateForFilename(session.sessionStartTime)
      const endTime = this.formatDateForFilename(Date.now())
      const outputPath = path.join(
        Transcription.getGuildTempDir(guildId),
        `transcription_audio_${startTime}_${endTime}.mp3`,
      )

      // 大量のファイルを処理するため、分割してマージ
      if (validRecordings.length > 20) {
        return await this.mergeAudioFilesInBatches(validRecordings, outputPath, session, guildId)
      }

      // 通常の処理（20個以下）
      const tempConvertedFiles: string[] = [];
      const inputFiles = [];
      for (let index = 0; index < validRecordings.length; index++) {
        const recording = validRecordings[index];
        const silence = this.calculateSilenceDuration(
          session.sessionStartTime,
          recording.startTime,
          validRecordings,
          index,
        );
        const convertedPath = path.join(
          Transcription.getGuildTempDir(guildId),
          `converted_${index}_${path.basename(recording.filePath)}`
        );
        // ffmpegで変換
        const cmd = `ffmpeg -y -i "${recording.filePath}" -ar 48000 -ac 2 "${convertedPath}"`;
        const result = shell.exec(cmd, { silent: true });
        if (result.code !== 0) {
          console.error(`[discord-whisper]Failed to convert audio: ${recording.filePath}`);
          continue;
        }
        tempConvertedFiles.push(convertedPath);
        inputFiles.push({ file: convertedPath, silence, userId: recording.userId });
      }

      await this.mergeWithFFmpeg(inputFiles, outputPath);

      // 変換した一時ファイルを削除
      for (const file of tempConvertedFiles) {
        try { fs.unlinkSync(file); } catch {}
      }

      console.log(
        `[discord-whisper]Audio files merged successfully: ${outputPath}`,
      )
      return outputPath;
    } catch (error) {
      console.error(`[discord-whisper]Error merging audio files:`, error)
      return null;
    }
  }

  private calculateSilenceDuration(
    sessionStart: number,
    recordingStart: number,
    allRecordings: GuildSession['audioRecordings'],
    currentIndex: number,
  ): number {
    if (currentIndex === 0) {
      return Math.max(0, recordingStart - sessionStart)
    } else {
      const previousRecording = allRecordings[currentIndex - 1]
      const previousEndTime =
        previousRecording.endTime ?? previousRecording.startTime
      return Math.max(0, recordingStart - previousEndTime)
    }
  }

  private async mergeAudioFilesInBatches(
    validRecordings: GuildSession['audioRecordings'],
    outputPath: string,
    session: GuildSession,
    guildId: string
  ): Promise<string | null> {
    try {
      console.log(`[discord-whisper]Merging ${validRecordings.length} audio files in batches`)
      
      const batchSize = 20 // FFmpegのコマンドライン制限を避けるため
      const tempBatchFiles: string[] = []
      
      // バッチごとに処理
      for (let batchIndex = 0; batchIndex < Math.ceil(validRecordings.length / batchSize); batchIndex++) {
        const batchStart = batchIndex * batchSize
        const batchEnd = Math.min(batchStart + batchSize, validRecordings.length)
        const batchRecordings = validRecordings.slice(batchStart, batchEnd)
        
        console.log(`[discord-whisper]Processing batch ${batchIndex + 1}/${Math.ceil(validRecordings.length / batchSize)} (${batchRecordings.length} files)`)
        
        const batchOutputPath = path.join(
          Transcription.getGuildTempDir(guildId),
          `batch_${batchIndex}.mp3`
        )
        
        const tempConvertedFiles: string[] = []
        const inputFiles = []
        
        for (let index = 0; index < batchRecordings.length; index++) {
          const recording = batchRecordings[index]
          const globalIndex = batchStart + index
          const silence = this.calculateSilenceDuration(
            session.sessionStartTime,
            recording.startTime,
            validRecordings,
            globalIndex,
          )
          
          const convertedPath = path.join(
            Transcription.getGuildTempDir(guildId),
            `batch_${batchIndex}_converted_${index}_${path.basename(recording.filePath)}`
          )
          
          const cmd = `ffmpeg -y -i "${recording.filePath}" -ar 48000 -ac 2 "${convertedPath}"`
          const result = shell.exec(cmd, { silent: true })
          if (result.code !== 0) {
            console.error(`[discord-whisper]Failed to convert audio in batch: ${recording.filePath}`)
            continue
          }
          
          tempConvertedFiles.push(convertedPath)
          inputFiles.push({ file: convertedPath, silence, userId: recording.userId })
        }
        
        if (inputFiles.length > 0) {
          await this.mergeWithFFmpeg(inputFiles, batchOutputPath)
          tempBatchFiles.push(batchOutputPath)
        }
        
        // バッチの変換ファイルを削除
        for (const file of tempConvertedFiles) {
          try { fs.unlinkSync(file) } catch {}
        }
      }
      
      // 全バッチファイルを最終的にマージ
      if (tempBatchFiles.length === 1) {
        // バッチが1つだけの場合はリネーム
        fs.renameSync(tempBatchFiles[0], outputPath)
      } else if (tempBatchFiles.length > 1) {
        // 複数バッチを結合
        await this.mergeWithFFmpegSimple(tempBatchFiles, outputPath)
        
        // バッチファイルを削除
        for (const file of tempBatchFiles) {
          try { fs.unlinkSync(file) } catch {}
        }
      }
      
      console.log(`[discord-whisper]Batch merging completed: ${outputPath}`)
      return outputPath
      
    } catch (error) {
      console.error(`[discord-whisper]Error in batch merging:`, error)
      return null
    }
  }

  private async mergeWithFFmpegSimple(
    inputFiles: string[],
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        // 単純な連結（無音挿入なし）
        let command = 'ffmpeg -y'
        inputFiles.forEach((file) => {
          command += ` -i "${file}"`
        })
        
        let concatInputs = ''
        for (let i = 0; i < inputFiles.length; i++) {
          concatInputs += `[${i}:a]`
        }
        
        command += ` -filter_complex "${concatInputs}concat=n=${inputFiles.length}:v=0:a=1[out]" -map "[out]" -codec:a libmp3lame -b:a 192k "${outputPath}"`
        
        console.log(`[discord-whisper]Executing final merge command`)
        
        const result = shell.exec(command, { silent: true })
        if (result.code !== 0) {
          reject(new Error(`FFmpeg batch merge failed: ${result.stderr}`))
        } else {
          resolve()
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async mergeWithFFmpeg(
    inputFiles: { file: string; silence: number; userId: string }[],
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        let command = 'ffmpeg -y';
        let filterComplex = '';

        inputFiles.forEach((input) => {
          command += ` -i "${input.file}"`;
        });

        let concatInputs = '';
        let streamCount = 0;
        inputFiles.forEach((input, index) => {
          if (input.silence > 0) {
            const silenceDurationSec = input.silence / 1000;
            filterComplex += `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${silenceDurationSec.toString()}[silence${index.toString()}];`;
            concatInputs += `[silence${index.toString()}][${index.toString()}:a]`;
            streamCount += 2;
          } else {
            concatInputs += `[${index.toString()}:a]`;
            streamCount += 1;
          }
        });

        filterComplex += `${concatInputs}concat=n=${streamCount}:v=0:a=1[out]`;
        // mp3出力用にエンコーダとビットレートを指定
        command += ` -filter_complex "${filterComplex}" -map "[out]" -codec:a libmp3lame -b:a 192k "${outputPath}"`;

        console.log(`[discord-whisper]Executing ffmpeg command: ${command}`);

        const result = shell.exec(command);
        if (result.code !== 0)
          reject(new Error(`FFmpeg failed: ${result.stderr}`));
        else resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
