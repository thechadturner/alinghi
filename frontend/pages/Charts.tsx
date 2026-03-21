import { onMount } from "solid-js";
import { logPageLoad } from "../utils/logging";

export default function Charts() {
  onMount(async () => {
    await logPageLoad('Charts.tsx', 'Charts Page');
  });
    return (
        <div class="w-full h-screen flex justify-center items-center">
        <div 
            class="grid grid-cols-4 grid-rows-2 gap-[25px]" 
            style="padding: 0 100px; box-sizing: border-box;"
        >
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
            <div class="flex justify-center items-center">
            <div class="w-[400px] h-[400px] bg-gray-200 pl-4">
                {/* <Chart /> */}
                <div class="text-center text-gray-500">Chart Placeholder</div>
            </div>
            </div>
        </div>
        </div>
    );
  }

