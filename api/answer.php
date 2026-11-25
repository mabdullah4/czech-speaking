<?php
declare(strict_types=1);

/**
 * Grade a spoken answer (Task 1) or spoken question (Task 2).
 * Prefer local Whisper on the VPS (no Gemini quota). Fall back to Gemini multimodal.
 */

require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$audioB64 = (string) ($input['audio'] ?? '');
$mime = (string) ($input['mime'] ?? 'audio/webm');
$mode = trim((string) ($input['mode'] ?? 'answer'));
if ($mode !== 'ask') {
    $mode = 'answer';
}

$question = trim((string) ($input['question'] ?? ''));
$situation = trim((string) ($input['situation'] ?? ''));
$hint = trim((string) ($input['hint'] ?? ''));
$modelQuestion = trim((string) ($input['model_question'] ?? ''));
$isFree = !empty($input['is_free']);

if ($audioB64 === '') {
    json_response(['error' => 'Missing audio'], 400);
}
if ($mode === 'answer' && $question === '') {
    json_response(['error' => 'Missing question'], 400);
}
if ($mode === 'ask' && $situation === '') {
    json_response(['error' => 'Missing situation'], 400);
}

if (str_starts_with($audioB64, 'data:')) {
    $comma = strpos($audioB64, ',');
    if ($comma !== false) {
        $meta = substr($audioB64, 5, $comma - 5);
        if (preg_match('#^([^;]+)#', $meta, $m)) {
            $mime = $m[1];
        }
        $audioB64 = substr($audioB64, $comma + 1);
    }
}

$bytes = base64_decode($audioB64, true);
if ($bytes === false || strlen($bytes) < 200) {
    json_response(['error' => 'Invalid audio'], 400);
}

global $STT_URL, $STT_API_KEY;
$sttUrl = $STT_URL;
$sttKey = $STT_API_KEY;

if ($sttUrl !== '') {
    if ($mode === 'ask') {
        $localResult = stt_grade_ask_remote(
            $sttUrl,
            $sttKey,
            $situation,
            $hint,
            $modelQuestion,
            $isFree,
            $bytes,
            $mime
        );
        if ($localResult['ok']) {
            json_response($localResult['data']);
        }
        // /v1/ask may be missing until Contabo is redeployed — fall through to Gemini.
        $sttErr = (string) ($localResult['error'] ?? '');
        $askEndpointMissing = (bool) preg_match('/\b404\b|not found|Method Not Allowed|405/i', $sttErr);
        if (!$askEndpointMissing) {
            json_response([
                'error' => $localResult['error'] ?? 'Local speech recognition failed. Try again.',
                'source' => 'whisper-local',
            ], 502);
        }
        // else: continue to Gemini ask grading below
    } else {
        $localResult = stt_grade_remote($sttUrl, $sttKey, $question, $bytes, $mime);
        if ($localResult['ok']) {
            json_response($localResult['data']);
        }
        // Do not fall through to Gemini — it is minutes-slow when overloaded.
        json_response([
            'error' => $localResult['error'] ?? 'Local speech recognition failed. Try again.',
            'source' => 'whisper-local',
        ], 502);
    }
}

require_api_key();

if ($mode === 'ask') {
    $hintLabel = $isFree ? 'learner invents their own question (no fixed hint)' : ($hint !== '' ? $hint : 'general info');
    $modelLine = $modelQuestion !== '' ? "Model question example: {$modelQuestion}\n" : '';
    $prompt = "Czech A2 permanent-residence oral exam — Task 2 (Dialogy).\n"
        . "The learner must ASK a polite formal question (vy), not answer.\n"
        . "Situation: {$situation}\n"
        . "Prompt/hint: {$hintLabel}\n"
        . $modelLine
        . "Transcribe the learner audio verbatim in Czech (keep mistakes, keep diacritics).\n"
        . "Then grade strictly:\n"
        . "- Must be a clear interrogative question (question word or verb-first yes/no question).\n"
        . "- Must use formal vy (máte/můžete/můžu…), not informal ty (máš/můžeš).\n"
        . "- For a fixed hint: the question must match that information need.\n"
        . "- For a free question: any relevant question about THIS situation is OK.\n"
        . "- Score 4–5 ONLY for a clear, on-topic, formal question.\n"
        . "- Fragments, statements, informal ty, or off-topic = max 2–3.\n"
        . 'Return JSON only: {"heard":"...","ok":true|false,"score":1-5,"note":"short English feedback","better":"model Czech question or null"}. '
        . 'If unintelligible: {"heard":"","ok":false,"score":1,"note":"No clear speech detected.","better":null}';

    $system = 'You are a strict Czech A2 oral-exam examiner grading Task 2 questions. '
        . 'Feedback notes must be in English. Output JSON only, no markdown.';
} else {
    $prompt = "Exam question (Czech): {$question}\n\n"
        . "Transcribe the learner audio verbatim in Czech (keep mistakes, keep diacritics). "
        . "Then grade strictly for A2 oral exam (permanent residence).\n"
        . "Rules: must be ONE full sentence; must make sense as an answer to THIS question. "
        . "Score 4–5 ONLY if the answer is on-topic AND a clear full sentence. "
        . "Short yes/no alone, off-topic, or fragmentary answers = max 2–3.\n"
        . 'Return JSON only: {"heard":"...","ok":true|false,"score":1-5,"note":"short English feedback naming the problem or success","better":"optional model Czech sentence or null"}. '
        . 'If unintelligible: {"heard":"","ok":false,"score":1,"note":"No clear speech detected.","better":null}';

    $system = 'You are a strict Czech A2 oral-exam examiner. '
        . 'Feedback notes must be in English. Output JSON only, no markdown.';
}

$result = gemini_interactions_failover($GOOGLE_API_KEYS, [
    'model' => $LISTEN_MODEL,
    'system_instruction' => $system,
    'input' => [
        [
            'type' => 'text',
            'text' => $prompt,
        ],
        [
            'type' => 'audio',
            'data' => $audioB64,
            'mime_type' => $mime,
        ],
    ],
    'generation_config' => [
        'thinking_level' => 'low',
        'max_output_tokens' => 320,
    ],
], 75);

if (!$result['ok']) {
    $status = gemini_is_rate_limited($result) ? 429 : 502;
    json_response([
        'error' => $result['error'] ?? 'Answer grading failed',
        'retry_after' => $status === 429 ? 20 : null,
        'hint' => $sttUrl !== '' ? 'VPS STT failed and Gemini fallback failed' : null,
    ], $status);
}

$parsed = gemini_extract_json_object($result['data']);
if (!is_array($parsed)) {
    $raw = gemini_walk_extract_text($result['data']);
    json_response([
        'transcript' => $raw,
        'feedback' => [
            'ok' => true,
            'score' => 3,
            'note' => 'Hotovo.',
            'better' => null,
        ],
        'source' => 'gemini',
    ]);
}

$transcript = trim((string) ($parsed['heard'] ?? ''));

json_response([
    'transcript' => $transcript,
    'feedback' => [
        'ok' => (bool) ($parsed['ok'] ?? ($transcript !== '')),
        'score' => (int) ($parsed['score'] ?? ($transcript !== '' ? 3 : 1)),
        'note' => (string) ($parsed['note'] ?? ''),
        'better' => $parsed['better'] ?? null,
    ],
    'source' => 'gemini',
]);

/**
 * @return array{ok:bool,data?:array,error?:string}
 */
function stt_grade_remote(string $baseUrl, string $apiKey, string $question, string $bytes, string $mime): array
{
    return stt_multipart_post(
        rtrim($baseUrl, '/') . '/v1/answer',
        $apiKey,
        $bytes,
        $mime,
        [
            'question' => $question,
        ]
    );
}

/**
 * @return array{ok:bool,data?:array,error?:string}
 */
function stt_grade_ask_remote(
    string $baseUrl,
    string $apiKey,
    string $situation,
    string $hint,
    string $modelQuestion,
    bool $isFree,
    string $bytes,
    string $mime
): array {
    return stt_multipart_post(
        rtrim($baseUrl, '/') . '/v1/ask',
        $apiKey,
        $bytes,
        $mime,
        [
            'situation' => $situation,
            'hint' => $hint,
            'model_question' => $modelQuestion,
            'is_free' => $isFree ? '1' : '0',
        ]
    );
}

/**
 * @param array<string,string> $fields
 * @return array{ok:bool,data?:array,error?:string}
 */
function stt_multipart_post(
    string $url,
    string $apiKey,
    string $bytes,
    string $mime,
    array $fields
): array {
    $boundary = '----speaking' . bin2hex(random_bytes(8));
    $ext = 'webm';
    if (stripos($mime, 'wav') !== false) {
        $ext = 'wav';
    } elseif (stripos($mime, 'ogg') !== false || stripos($mime, 'opus') !== false) {
        $ext = 'ogg';
    } elseif (stripos($mime, 'mp4') !== false || stripos($mime, 'm4a') !== false) {
        $ext = 'm4a';
    }

    $body = '';
    foreach ($fields as $name => $value) {
        $body .= "--{$boundary}\r\n";
        $body .= "Content-Disposition: form-data; name=\"{$name}\"\r\n\r\n";
        $body .= $value . "\r\n";
    }
    $body .= "--{$boundary}\r\n";
    $body .= "Content-Disposition: form-data; name=\"audio\"; filename=\"answer.{$ext}\"\r\n";
    $body .= 'Content-Type: ' . $mime . "\r\n\r\n";
    $body .= $bytes . "\r\n";
    $body .= "--{$boundary}--\r\n";

    $headers = [
        'Content-Type: multipart/form-data; boundary=' . $boundary,
    ];
    if ($apiKey !== '') {
        $headers[] = 'X-API-Key: ' . $apiKey;
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 90,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($errno) {
        return ['ok' => false, 'error' => $error ?: 'STT cURL error'];
    }

    $decoded = json_decode((string) $raw, true);
    if ($status >= 400 || !is_array($decoded)) {
        $msg = is_array($decoded) ? (string) ($decoded['detail'] ?? $decoded['error'] ?? 'STT HTTP ' . $status) : ('STT HTTP ' . $status);
        return ['ok' => false, 'error' => $msg];
    }

    $transcript = trim((string) ($decoded['heard'] ?? ''));
    return [
        'ok' => true,
        'data' => [
            'transcript' => $transcript,
            'feedback' => [
                'ok' => (bool) ($decoded['ok'] ?? ($transcript !== '')),
                'score' => (int) ($decoded['score'] ?? 3),
                'note' => (string) ($decoded['note'] ?? ''),
                'better' => $decoded['better'] ?? null,
            ],
            'source' => (string) ($decoded['source'] ?? 'whisper-local'),
        ],
    ];
}
