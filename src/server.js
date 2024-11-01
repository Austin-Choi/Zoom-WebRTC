import express from "express";
import http from "http";
import SocketIO from "socket.io";
import dotenv from 'dotenv';
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { PassThrough } from "stream";

// dotenv import하고 서버 초기화 전에 .config() 실행해야
// 환경변수 읽을 수 있음
dotenv.config();
const app = express();

app.set('view engine', "pug");
app.set("views", __dirname + "/views");
app.use("/public", express.static(__dirname + "/public"));
app.get("/", (req, res) => res.render("home"));
app.get("/*", (req, res) => res.redirect("/"));

// 같은 서버에서 http랑 ws 서버 둘 다 돌림(같은 포트에서 처리 가능)
const httpServer = http.createServer(app);
const wsServer = SocketIO(httpServer);

// 오디오 데이터를 받을 스트림
let audioStream = new PassThrough();


let transcribeSessionActive = false;
let abortController = null;

const LanguageCode = "ko-KR";
const MediaEncoding = "pcm";
const MediaSampleRateHertz = 48000;  // 추천되는건 16000
const targetChunkSize = 16000; // 16kb target chunk size
const chunkInterval = 500; // 0.5 seconds

async function startTranscribe(roomName) {
    console.log("startTranscribe function called");

    abortController = new AbortController();
    const client = new TranscribeStreamingClient({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_ID,
            secretAccessKey: process.env.AWS_SECRET_ID,
        },
    });

    const params = {
        LanguageCode,
        MediaEncoding,
        MediaSampleRateHertz,
        AudioStream: (async function* () {
            // console.log("AudioStream generator started");

            let buffer = Buffer.alloc(0);
    
            for await (const chunk of audioStream) {
                // console.log("Processing audio chunk in AudioStream");

                if (!transcribeSessionActive) break;  // 세션 비활성화 시 루프 종료
                buffer = Buffer.concat([buffer, chunk]);
    
                // 0.5초마다 버퍼를 확인하고 16KB 청크로 나누어 전송
                while (buffer.length >= targetChunkSize) {
                    const chunkToSend = buffer.subarray(0, targetChunkSize);
                    buffer = buffer.subarray(targetChunkSize); // 전송된 부분을 버퍼에서 제거
                    yield { AudioEvent: { AudioChunk: chunkToSend } };
                    // console.log("Transmitting 16KB chunk");
                }
    
                // 0.5초 대기
                await new Promise(resolve => setTimeout(resolve, chunkInterval));
            }
    
            // 마지막 남은 데이터를 Transcribe로 전달
            if (buffer.length > 0) {
                yield { AudioEvent: { AudioChunk: buffer } };
            }
        })(),
    };

    const command = new StartStreamTranscriptionCommand(params);

    

    // 이벤트 수신까지는 확인함
    // 이 부분 고쳐 보기 
    try {
        transcribeSessionActive = true;
        const response = await client.send(
            command,
            {   
                // AbortController 연결
                signal: abortController.signal
            } 
        );
        
        // for await...of를 사용하여 TranscriptResultStream 처리
        for await (const event of response.TranscriptResultStream) {
            // console.log(event);
            const transcriptEvent = event.TranscriptEvent;
            if (transcriptEvent && transcriptEvent.Transcript) {
                const results = transcriptEvent.Transcript.Results;
                // console.log("Transcribe event results : ", results);
                results.forEach(result => {
                    if (!result.IsPartial) {
                        const transcript = result.Alternatives[0].Transcript;
                        console.log("Final Transcript:", transcript);
                        wsServer.to(roomName).emit("peer_message", transcript);
                    }
                });
            }
        }
    }
    catch(error) {
        if (error.name === 'AbortError') {
            console.log("Transcribe session aborted as expected."); // AbortError를 정상 처리로 인식
        } else {
            console.error("Transcribe error:", error); // 다른 오류는 로그에 출력
        }
    }
    finally {
        // 트랜스크립션 종료 시 세션 비활성화
        transcribeSessionActive = false;
    }
}

wsServer.on("connection", socket => {
    socket.on("join_room", async (roomName, email) => {
        const room = wsServer.sockets.adapter.rooms.get(roomName);
        const userCount = room ? room.size : 0;
        console.log("방 ", roomName,"의 인원 : ", userCount);

        // 2명 이상이면 room_full event 발생시킴
        if(userCount >= 2)
            socket.emit("room_full");
        else {
            socket.join(roomName);
            // 이메일을 소켓 객체에 저장
            socket.email = email;
            // 자기 자신도 initCall을 호출할 수 있게 함
            socket.emit("welcome_self", () => {
                // 클라이언트가 welcome_self 처리를 완료했다는 응답을 보낸 후 실행
                socket.to(roomName).emit("welcome");
            });

            // 입장한 사용자의 이메일로 입장 알림을 줌
            wsServer.to(roomName).emit("notification", `${email}님이 입장하셨습니다.`);
            // AWS Transcribe 시작
            if(userCount > 0)
                console.log("시작");
                startTranscribe(roomName);
        }
    });
    socket.on("audio_chunk", (chunk) => {
        // 클라이언트에서 받은 오디오 데이터를 audioStream에 추가
        // console.log("Received audio chunk size:", chunk.length); 
        audioStream.write(chunk);
        // console.log("Chunk written to audioStream");
    });
    // caller가 offer로 보낸 sdp를 통화를 연결하려는 방에 보냄
    socket.on("offer", (offer, roomName)=>{
        // console.log("roomName:", roomName, " offer : ", offer);
        socket.to(roomName).emit("offer", offer);
    });
    socket.on("answer", (answer, roomName)=>{
        socket.to(roomName).emit("answer", answer);
    });
    socket.on("ice", (ice, roomName)=> {
        socket.to(roomName).emit("ice", ice);
    });
    // 통화 종료 
    socket.on("leave_room", (roomName)=> {
        console.log(socket.email, "님이 방 ", roomName, "에서 나갔습니다.");
        socket.leave(roomName);
        

        const room = wsServer.sockets.adapter.rooms.get(roomName);
        const userCount = room ? room.size : 0;
        console.log("현재 방 ", roomName, "의 인원은 ", userCount);
        wsServer.to(roomName).emit("notification", `${socket.email}님이 퇴장하셨습니다.`);

        // Transcribe 종료 및 audioStream 초기화
        
        // 방에 사용자가 남아있지 않다면 AWS Transcribe 세션 종료
        if(userCount === 0 && abortController) {
            transcribeSessionActive = false;
            abortController.abort();
            abortController = null;
            audioStream = new PassThrough();
            wsServer.sockets.adapter.rooms.delete(roomName);
            console.log("Transcribe session aborted.");
            console.log("방 ", roomName, " 이 삭제되었습니다.")
        }
    });
    socket.on("my_message", (message) => {
        const roomName = Array.from(socket.rooms)[1]; // 첫 번째 요소는 소켓 ID
        if (roomName) {
            console.log("Broadcasting message to room:", roomName, "Message:", message);
            wsServer.to(roomName).emit("my_message", message); // 특정 방으로 전송
        } 
    });
    
    
});

const handleListen = () => console.log('Listening on http://localhost:3000');
httpServer.listen(3000, handleListen);